import * as THREE from 'three'
import { Y0, FOOT } from './world.js'
import { makeBox, worldUV, scaleUV, shadowAll } from './geo.js'
import { patchFlagMaterial, createFlameMaterial } from './shaders.js'

/**
 * Замок: стіни, вежі, брама з підйомним мостом, донжон, зала, стайня, колодязь, ринок.
 * Усе зібрано з ПРИМІТИВІВ (Box, Cylinder, Cone, Lathe, Torus, Sphere, Circle, Plane)
 * та двох ExtrudeGeometry (арка брами з отвором, двосхилий дах).
 *
 * Група замку стоїть на висоті Y0 (плато пагорба), тому всередині локальні висоти починаються з 0.
 * Колайдери для фізики збираються тут же (у світових координатах) — фізика не вигадує власної геометрії.
 */
export const createCastle = (M, timeUniform) =>
{
    const group = new THREE.Group()
    group.name = 'castle'
    group.position.y = Y0

    const colliders = []   // { x, y, z, hx, hy, hz, ry } — статичні коробки для cannon-es
    const lights = []      // PointLight від смолоскипів (мерехтіння керується в main.js)
    const flames = []      // матеріали полум'я (інтенсивність залежить від часу доби)
    const flags = []       // полотнища з шейдером хвиль
    const smokeSources = []// точки, з яких іде дим
    const dynamicProps = []// бочки / ящики / тюки: об'єкт + параметри для фізики
    const patrols = []     // маршрути вартових на стінах

    const T = 2.4          // товщина стін
    const H = 9            // висота стін
    const { hx, hz } = FOOT

    /* ---------- допоміжні функції ---------- */
    const addCollider = (x, y, z, w, h, d, ry = 0) =>
        colliders.push({ x, y: y + Y0, z, hx: w / 2, hy: h / 2, hz: d / 2, ry })

    // Круглу вежу апроксимуємо двома квадратами, повернутими на 45° (вісімкою)
    const addRoundCollider = (x, y, z, r, h) =>
    {
        const a = r * 0.93 * 2
        addCollider(x, y, z, a, h, a, 0)
        addCollider(x, y, z, a, h, a, Math.PI / 4)
    }

    const cylUV = (geometry, r, h, tile = 3) =>
    {
        const uv = geometry.attributes.uv
        for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r / tile, uv.getY(i) * h / tile)
        return geometry
    }

    const add = (mesh, x, y, z, parent = group) =>
    {
        mesh.position.set(x, y, z)
        parent.add(mesh)
        return mesh
    }

    const box = (w, h, d, mat, x, y, z, tile = 3, parent = group) => add(makeBox(w, h, d, mat, tile), x, y, z, parent)

    const cylinder = (rTop, rBot, h, seg, mat, x, y, z, tile = 3, parent = group) =>
    {
        const mesh = new THREE.Mesh(cylUV(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1), (rTop + rBot) / 2, h, tile), mat)
        mesh.castShadow = mesh.receiveShadow = true
        return add(mesh, x, y, z, parent)
    }

    const cone = (r, h, seg, mat, x, y, z) =>
    {
        const g = new THREE.ConeGeometry(r, h, seg, 1)
        const uv = g.attributes.uv
        for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r / 3, uv.getY(i) * Math.hypot(r, h) / 3)
        const mesh = new THREE.Mesh(g, mat)
        mesh.castShadow = mesh.receiveShadow = true
        return add(mesh, x, y, z)
    }

    const sphere = (r, mat, x, y, z, parent = group) =>
    {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat)
        mesh.castShadow = true
        return add(mesh, x, y, z, parent)
    }

    /* ---------- зубці (merlons), вікна, бійниці: InstancedMesh ---------- */
    // Один InstancedMesh замість сотень окремих Mesh → один draw call
    const merlonSets = {
        brick: { mat: M.wall, list: [] },
        stone: { mat: M.limestone, list: [] }
    }
    const merlon = (set, x, y, z, ry) => merlonSets[set].list.push([x, y, z, ry])

    // Зубці вздовж відрізка стіни: від (x0,z0) до (x1,z1), на висоті y, зсув n — перпендикулярно (назовні)
    const merlonRow = (set, x0, z0, x1, z1, y, step = 2.6, skip = () => false) =>
    {
        const len = Math.hypot(x1 - x0, z1 - z0)
        const n = Math.max(1, Math.floor(len / step))
        const ry = Math.atan2(-(z1 - z0), x1 - x0)
        for(let i = 0; i < n; i++)
        {
            const t = (i + 0.5) / n
            const x = x0 + (x1 - x0) * t
            const z = z0 + (z1 - z0) * t
            if(!skip(x, z)) merlon(set, x, y + 0.65, z, ry)
        }
    }

    const slitList = []
    const winList = []
    const slit = (x, y, z, ry = 0) => slitList.push([x, y, z, ry])
    const windowAt = (x, y, z, ry = 0) => winList.push([x, y, z, ry])

    const glass = M.makeGlass() // спільне «скло» вікон: вночі світиться
    const slitGlass = M.makeGlass() // бійниці: майже чорні вдень, жовті вночі
    slitGlass.roughness = 0.95

    /* ---------- двір: бруківка ---------- */
    box(2 * hx, 0.3, 2 * hz, M.cobble, 0, -0.1, 0, 3)

    /* ---------- стіни ---------- */
    const cornerR = 4.4
    const nearCorner = (x, z) => Math.hypot(Math.abs(x) - hx, Math.abs(z) - hz) < cornerR + 0.8

    // північна (задня) стіна
    box(2 * hx + T, H, T, M.wall, 0, H / 2, -hz)
    addCollider(0, H / 2, -hz, 2 * hx + T, H, T)
    // західна й східна
    for(const s of [-1, 1])
    {
        box(T, H, 2 * hz + T, M.wall, s * hx, H / 2, 0)
        addCollider(s * hx, H / 2, 0, T, H, 2 * hz + T)
    }
    // південна: два відрізки з проходом під брамою
    const segW = hx - 6 + T / 2
    for(const s of [-1, 1])
    {
        box(segW, H, T, M.wall, s * (6 + segW / 2), H / 2, hz)
        addCollider(s * (6 + segW / 2), H / 2, hz, segW, H, T)
    }
    // цоколь (темніший камінь) — візуально «тримає» стіну
    box(2 * hx + T + 0.8, 1.2, T + 0.8, M.darkStone, 0, 0.6, -hz)
    for(const s of [-1, 1])
    {
        box(T + 0.8, 1.2, 2 * hz + T + 0.8, M.darkStone, s * hx, 0.6, 0)
        box(segW, 1.2, T + 0.8, M.darkStone, s * (6 + segW / 2), 0.6, hz)
    }

    // зубці по зовнішньому краю стін (товщина 0,8 м, прохід за ними 1,6 м)
    const out = T / 2 - 0.4
    merlonRow('brick', -hx - T / 2, -hz - out, hx + T / 2, -hz - out, H, 2.6, nearCorner)
    merlonRow('brick', -hx - out, -hz - T / 2, -hx - out, hz + T / 2, H, 2.6, nearCorner)
    merlonRow('brick', hx + out, -hz - T / 2, hx + out, hz + T / 2, H, 2.6, nearCorner)
    for(const s of [-1, 1])
        merlonRow('brick', s * 6.4, hz + out, s * (hx + T / 2), hz + out, H, 2.6, nearCorner)
    // зубці повернуті довгою стороною вздовж стіни; для бокових стін поворот ±90° уже в ry (atan2)

    // бійниці
    for(let x = -18; x <= 18; x += 4.8)
    {
        slit(x, 5.4, -hz - T / 2 - 0.02, 0)
        if(Math.abs(x) > 7.5) slit(x, 5.4, hz + T / 2 + 0.02, 0)
    }
    for(let z = -12; z <= 12; z += 4.8)
    {
        slit(-hx - T / 2 - 0.02, 5.4, z, Math.PI / 2)
        slit(hx + T / 2 + 0.02, 5.4, z, Math.PI / 2)
    }

    /* ---------- кутові вежі з конічними дахами ---------- */
    const makeTower = (x, z, r, h, roofH, mat, flagIndex = null) =>
    {
        cylinder(r * 0.94, r, h, 28, mat, x, h / 2, z)
        cylinder(r + 0.45, r + 0.45, 0.7, 28, M.darkStone, x, h - 0.1, z) // карниз (corbel ring)
        cylinder(r + 0.75, r + 0.75, 1.2, 28, M.darkStone, x, 0.6, z)     // цоколь
        cone(r + 1.0, roofH, 28, M.roof, x, h + roofH / 2 + 0.2, z)
        sphere(0.28, M.bronze, x, h + roofH + 0.35, z)                    // бронзовий навершок
        addRoundCollider(x, h / 2, z, r, h)
        // бійниці по колу
        for(let k = 0; k < 6; k++)
        {
            const a = (k / 6) * Math.PI * 2 + 0.4
            slit(x + Math.cos(a) * (r * 0.96), h * 0.62, z + Math.sin(a) * (r * 0.96), -a + Math.PI / 2)
        }
        if(flagIndex !== null) makeFlag(x, h + roofH + 0.4, z, 2.2, 1.3, flagIndex, 4)
    }

    // Полотнище прапора: PlaneGeometry із сегментами + шейдер хвилі (patchFlagMaterial)
    const makeFlag = (x, baseY, z, w, h, bannerIndex, poleH = 5) =>
    {
        const pole = cylinder(0.07, 0.09, poleH, 8, M.woodMat('#8a6a48'), x, baseY + poleH / 2, z)
        pole.castShadow = true
        const mat = new THREE.MeshStandardMaterial({ map: M.banners[bannerIndex], side: THREE.DoubleSide, roughness: 0.85 })
        patchFlagMaterial(mat, timeUniform, w, 0.28 * Math.min(1.2, w / 2))
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 40, 16), mat)
        flag.castShadow = true
        flag.position.set(x + w / 2 + 0.07, baseY + poleH - h / 2 - 0.2, z)
        group.add(flag)
        flags.push(flag)
        sphere(0.12, M.bronze, x, baseY + poleH + 0.08, z)
        return flag
    }

    makeTower(-hx, -hz, cornerR, 15, 7.5, M.limestone, 1)
    makeTower(hx, -hz, cornerR, 15, 7.5, M.limestone, 0)
    makeTower(-hx, hz, cornerR, 15, 7.5, M.limestone, 0)
    makeTower(hx, hz, cornerR, 15, 7.5, M.limestone, 1)

    /* ---------- брама ---------- */
    // ExtrudeGeometry: контур 12×12 м з отвором-аркою (прямокутник + півколо), видавлений на 7 м
    {
        const shape = new THREE.Shape()
        shape.moveTo(-6, 0)
        shape.lineTo(6, 0)
        shape.lineTo(6, 12)
        shape.lineTo(-6, 12)
        shape.lineTo(-6, 0)
        const arch = new THREE.Path()
        arch.moveTo(-2.2, 0)
        arch.lineTo(-2.2, 4.2)
        arch.absarc(0, 4.2, 2.2, Math.PI, 0, true)
        arch.lineTo(2.2, 0)
        arch.lineTo(-2.2, 0)
        shape.holes.push(arch)
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: 7, bevelEnabled: false, curveSegments: 24 })
        geometry.translate(0, 0, -3.5)
        scaleUV(geometry, 3)
        const mesh = new THREE.Mesh(geometry, M.limestone)
        mesh.castShadow = mesh.receiveShadow = true
        add(mesh, 0, 0, hz)
    }
    // колайдери брами: два бокових блоки + перемичка над проходом
    for(const s of [-1, 1]) addCollider(s * 4.1, 6, hz, 3.8, 12, 7)
    addCollider(0, 9.2, hz, 4.4, 5.6, 7)
    // зубці на даху брами
    merlonRow('stone', -5.6, hz + 3.1, 5.6, hz + 3.1, 12, 2.0)
    merlonRow('stone', -5.6, hz - 3.1, 5.6, hz - 3.1, 12, 2.0)
    merlonRow('stone', -5.7, hz - 3.1, -5.7, hz + 3.1, 12, 2.2)
    merlonRow('stone', 5.7, hz - 3.1, 5.7, hz + 3.1, 12, 2.2)
    // карниз над аркою й герб-щит
    box(12.4, 0.5, 7.4, M.darkStone, 0, 11.9, hz, 3)
    box(1.8, 2.2, 0.25, M.darkIron, 0, 9.0, hz + 3.55)
    sphere(0.38, M.bronze, 0, 9.0, hz + 3.75)
    // вежки-ліхтарі по боках брами
    for(const s of [-1, 1])
    {
        const tx = s * 6.3
        const tz = hz + 3.0
        cylinder(2.0, 2.15, 14, 20, M.limestone, tx, 7, tz)
        cylinder(2.5, 2.5, 0.6, 20, M.darkStone, tx, 13.8, tz)
        cone(2.7, 5.5, 20, M.roof, tx, 16.8, tz)
        sphere(0.2, M.bronze, tx, 19.7, tz)
        addRoundCollider(tx, 7, tz, 2.0, 14)
        for(let k = 0; k < 4; k++) slit(tx + Math.sin(k * 0.9 - 1.2) * 2.05, 9.5, tz + Math.cos(k * 0.9 - 1.2) * 2.05, k * 0.9 - 1.2)
    }
    makeFlag(0, 12.2, hz, 2.6, 1.6, 0, 4.2)

    // Опускна решітка (portcullis): ґрати з залізних прутів; піднімається в корпус брами
    const portcullis = new THREE.Group()
    {
        const barGeo = new THREE.CylinderGeometry(0.07, 0.07, 6.7, 8)
        const hGeo = new THREE.CylinderGeometry(0.06, 0.06, 4.6, 8)
        for(let i = 0; i <= 14; i++)
        {
            const bar = new THREE.Mesh(barGeo, M.darkIron)
            bar.position.set(-2.1 + i * 0.3, 3.35, 0)
            bar.castShadow = true
            portcullis.add(bar)
            const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 8), M.darkIron)
            tip.position.set(-2.1 + i * 0.3, -0.12, 0)
            tip.rotation.x = Math.PI
            portcullis.add(tip)
        }
        for(let j = 0; j < 8; j++)
        {
            const rail = new THREE.Mesh(hGeo, M.darkIron)
            rail.rotation.z = Math.PI / 2
            rail.position.set(0, 0.8 + j * 0.85, 0.09)
            rail.castShadow = true
            portcullis.add(rail)
        }
        portcullis.position.set(0, 0, hz + 2.2)
        group.add(portcullis)
    }

    // Двостулкові дерев'яні ворота, відчинені всередину (стулки притиснуті до стін проходу)
    for(const s of [-1, 1])
    {
        const hinge = new THREE.Group()
        hinge.position.set(s * 2.2, 0, hz - 1.6)
        hinge.rotation.y = s * (Math.PI / 2 - 0.12)
        const leaf = makeBox(2.15, 4.2, 0.22, M.woodMat('#9c8a78'), 2.0)
        leaf.position.set(-s * 1.08, 2.1, 0)
        hinge.add(leaf)
        for(const y of [0.8, 2.1, 3.4])
        {
            const strap = makeBox(2.15, 0.16, 0.06, M.darkIron, 1)
            strap.position.set(-s * 1.08, y, 0.14)
            hinge.add(strap)
        }
        group.add(hinge)
    }
    // поріг проходу
    box(4.4, 0.3, 7, M.cobble, 0, -0.1, hz, 3)

    /* ---------- підйомний міст ---------- */
    const bridgeLen = 11.2
    const bridgePivot = new THREE.Group()
    bridgePivot.position.set(0, 0.25, hz + 3.6)
    group.add(bridgePivot)
    {
        const deck = makeBox(4.3, 0.36, bridgeLen, M.woodMat(), 2.4, 2.4)
        deck.position.set(0, 0, bridgeLen / 2)
        bridgePivot.add(deck)
        for(const s of [-1, 1])
        {
            const rail = makeBox(0.2, 0.9, bridgeLen, M.woodMat('#7a6858'), 2.4)
            rail.position.set(s * 2.0, 0.6, bridgeLen / 2)
            bridgePivot.add(rail)
            for(let k = 0; k < 6; k++)
            {
                const post = makeBox(0.28, 1.15, 0.28, M.woodMat('#6e5c4c'), 2.4)
                post.position.set(s * 2.0, 0.55, 0.5 + k * 2.05)
                bridgePivot.add(post)
            }
        }
        // залізні накладки
        for(let k = 0; k < 7; k++)
        {
            const band = makeBox(4.3, 0.04, 0.12, M.darkIron, 1)
            band.position.set(0, 0.2, 0.6 + k * 1.6)
            bridgePivot.add(band)
        }
    }
    // ланцюги: тонкі циліндри від воріт до кінця настилу; перераховуються в setBridge()
    const chainGeo = new THREE.CylinderGeometry(0.075, 0.075, 1, 8)
    const chains = [-1, 1].map((s) =>
    {
        const m = new THREE.Mesh(chainGeo, M.darkIron)
        m.castShadow = true
        group.add(m)
        return { mesh: m, s }
    })
    const _a = new THREE.Vector3()
    const _b = new THREE.Vector3()
    const _dir = new THREE.Vector3()
    const _up = new THREE.Vector3(0, 1, 0)
    // angle = 0 — міст опущений, ≈ -1.3 рад — піднятий
    const setBridge = (angle) =>
    {
        bridgePivot.rotation.x = angle
        bridgePivot.updateMatrixWorld(true)
        for(const { mesh, s } of chains)
        {
            _a.set(s * 2.0, 8.2, hz + 3.7)                          // кріплення на брамі
            _b.set(s * 2.0, 0.45, bridgeLen - 0.4)                 // точка на краю настилу (локально)
            bridgePivot.localToWorld(_b)
            group.worldToLocal(_b)
            _dir.subVectors(_b, _a)
            mesh.position.copy(_a).addScaledVector(_dir, 0.5)
            mesh.quaternion.setFromUnitVectors(_up, _dir.clone().normalize())
            mesh.scale.set(1, _dir.length(), 1)
        }
    }
    setBridge(0)

    /* ---------- донжон (головна вежа) ---------- */
    const keepZ = -9.5
    box(12, 22, 10, M.limestone, 0, 11, keepZ)
    addCollider(0, 11, keepZ, 12, 22, 10)
    box(12.8, 0.9, 10.8, M.darkStone, 0, 22.2, keepZ)          // карниз
    box(12.8, 1.4, 10.8, M.darkStone, 0, 0.7, keepZ)           // цоколь
    merlonRow('stone', -5.9, keepZ + 5.0, 5.9, keepZ + 5.0, 22.65, 2.0)
    merlonRow('stone', -5.9, keepZ - 5.0, 5.9, keepZ - 5.0, 22.65, 2.0)
    merlonRow('stone', -5.9, keepZ - 4.9, -5.9, keepZ + 4.9, 22.65, 2.0)
    merlonRow('stone', 5.9, keepZ - 4.9, 5.9, keepZ + 4.9, 22.65, 2.0)
    // кутові башточки з червоним дахом
    for(const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
    {
        const tx = sx * 6.0
        const tz = keepZ + sz * 5.0
        cylinder(1.5, 1.6, 26, 16, M.limestone, tx, 13, tz)
        cylinder(1.95, 1.95, 0.5, 16, M.darkStone, tx, 25.6, tz)
        cone(2.1, 4.2, 16, M.roofRed, tx, 28.1, tz)
        sphere(0.16, M.bronze, tx, 30.3, tz)
        addCollider(tx, 13, tz, 2.4, 26, 2.4)
    }
    makeFlag(0, 22.6, keepZ, 5.0, 3.0, 0, 8)
    // вікна донжона
    for(const y of [8, 12.6, 17.2])
        for(const x of [-3.4, 3.4]) windowAt(x, y, keepZ + 5.02, 0)
    for(const x of [-3.4, 3.4]) windowAt(x, 20.5, keepZ + 5.02, 0)
    for(const y of [10, 16])
        for(const z of [-2.5, 2.5])
        {
            windowAt(6.02, y, keepZ + z, Math.PI / 2)
            windowAt(-6.02, y, keepZ + z, -Math.PI / 2)
        }
    for(const y of [10, 16]) for(const x of [-3, 3]) windowAt(x, y, keepZ - 5.02, Math.PI)

    // вхід у донжон: сходи, портал, двері з текстурами курсу (displacement + alpha + AO + metalness...)
    {
        const zf = keepZ + 5.0
        box(4.8, 1.3, 1.6, M.darkStone, 0, 0.65, zf + 0.8)
        for(const s of [-1, 1]) box(0.55, 3.8, 0.8, M.darkStone, s * 1.55, 1.3 + 1.9, zf + 0.3)
        box(3.8, 0.7, 0.8, M.darkStone, 0, 1.3 + 3.8 + 0.2, zf + 0.3)
        const doorMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 3.6, 96, 96), M.door)
        doorMesh.position.set(0, 1.3 + 1.8, zf + 0.02)
        doorMesh.receiveShadow = true
        group.add(doorMesh)
        // дві сходинки перед площадкою
        for(let i = 0; i < 2; i++)
        {
            const h = 0.87 - i * 0.44
            box(4.0, h, 0.8, M.darkStone, 0, h / 2, zf + 2.0 + i * 0.8)
        }
    }

    /* ---------- велика зала (двосхилий дах з ExtrudeGeometry) ---------- */
    const hallX = 17
    const hallZ = -2
    box(8, 6, 20, M.limestone, hallX, 3, hallZ)
    addCollider(hallX, 3, hallZ, 8, 6, 20)
    {
        // трикутний профіль даху видавлюється вздовж довжини будівлі
        const profile = new THREE.Shape()
        profile.moveTo(-5.0, 0)
        profile.lineTo(5.0, 0)
        profile.lineTo(0, 4.4)
        profile.lineTo(-5.0, 0)
        const geometry = new THREE.ExtrudeGeometry(profile, { depth: 21.6, bevelEnabled: false })
        geometry.translate(0, 0, -10.8)
        scaleUV(geometry, 3)
        const roof = new THREE.Mesh(geometry, M.roofRed)
        roof.castShadow = roof.receiveShadow = true
        add(roof, hallX, 6, hallZ)
        // повітряні (вітрові) дошки по коньку
        box(0.25, 0.25, 21.8, M.frame, hallX, 10.5, hallZ, 1)
    }
    // фахверк на фасаді зі сторони двору (темні балки поверх штукатурки)
    for(let z = -11; z <= 7.01; z += 3)
        box(0.2, 6, 0.28, M.frame, hallX - 4.06, 3, hallZ + z + 1, 1)
    for(const y of [0.6, 3.2, 5.9]) box(0.2, 0.28, 20.2, M.frame, hallX - 4.06, y, hallZ, 1)
    for(const z of [-7.5, -4, 4, 7.5]) windowAt(hallX - 4.04, 3.4, hallZ + z, -Math.PI / 2)
    // двері зали
    {
        const dm = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3.3, 96, 96), M.door)
        dm.position.set(hallX - 4.04, 1.65, hallZ)
        dm.rotation.y = -Math.PI / 2
        group.add(dm)
        for(const s of [-1, 1]) box(0.5, 3.6, 0.6, M.darkStone, hallX - 4.2, 1.8, hallZ + s * 1.45)
        box(0.6, 0.6, 3.6, M.darkStone, hallX - 4.2, 3.7, hallZ)
        box(1.4, 0.3, 4.0, M.darkStone, hallX - 4.9, 0.15, hallZ)
    }
    // димар
    box(1.2, 4.2, 1.2, M.darkStone, hallX + 1.5, 10.9, hallZ + 6)
    box(1.5, 0.3, 1.5, M.darkStone, hallX + 1.5, 13.1, hallZ + 6)
    smokeSources.push(new THREE.Vector3(hallX + 1.5, Y0 + 13.3, hallZ + 6))

    /* ---------- стайня (відкритий навіс) ---------- */
    const stX = -17.5
    const stZ = 5.5
    box(0.7, 4.6, 10, M.wall, stX - 4.2, 2.3, stZ)
    box(8.4, 4.6, 0.7, M.wall, stX, 2.3, stZ - 5.0)
    box(8.4, 4.0, 0.7, M.wall, stX, 2.0, stZ + 5.0)
    addCollider(stX - 4.2, 2.3, stZ, 0.7, 4.6, 10)
    addCollider(stX, 2.3, stZ - 5.0, 8.4, 4.6, 0.7)
    addCollider(stX, 2.0, stZ + 5.0, 8.4, 4.0, 0.7)
    {
        // односхилий дах: нахилена плита + крокви
        const roofSlab = makeBox(9.6, 0.3, 11.2, M.roof, 3)
        roofSlab.position.set(stX - 0.2, 4.55, stZ)
        roofSlab.rotation.z = -0.16
        group.add(roofSlab)
        for(const z of [-5, -1.7, 1.7, 5]) box(0.28, 3.9, 0.28, M.woodMat('#6e5c4c'), stX + 3.6, 1.95, stZ + z, 2)
        box(0.3, 0.3, 11, M.woodMat('#6e5c4c'), stX + 3.6, 3.95, stZ, 2)
    }
    box(5, 0.5, 0.8, M.woodMat(), stX - 1, 0.8, stZ - 3.6, 2)   // годівниця
    box(5, 0.3, 0.5, M.woodMat('#5b4837'), stX - 1, 1.15, stZ - 3.6, 2)

    /* ---------- колодязь ---------- */
    const wellX = 5.5
    const wellZ = 7
    {
        const profile = [[1.0, 0], [1.4, 0], [1.4, 1.05], [1.12, 1.05], [1.12, 0.9], [1.0, 0.9], [1.0, 0]].map(([x, y]) => new THREE.Vector2(x, y))
        const g = new THREE.LatheGeometry(profile, 24)
        const uv = g.attributes.uv
        for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 9, uv.getY(i) * 2)
        const ring = new THREE.Mesh(g, M.limestone)
        ring.castShadow = ring.receiveShadow = true
        add(ring, wellX, 0, wellZ)
        const water = new THREE.Mesh(new THREE.CircleGeometry(1.0, 24), new THREE.MeshStandardMaterial({ color: '#16303a', roughness: 0.05, metalness: 0.6 }))
        water.rotation.x = -Math.PI / 2
        add(water, wellX, 0.55, wellZ)
        for(const s of [-1, 1]) box(0.2, 3.1, 0.2, M.woodMat('#6e5c4c'), wellX + s * 1.25, 1.55, wellZ, 2)
        const beam = cylinder(0.1, 0.1, 2.8, 10, M.woodMat('#8a6a48'), wellX, 2.7, wellZ, 2)
        beam.rotation.z = Math.PI / 2
        // двосхилий дашок з Extrude
        const tri = new THREE.Shape()
        tri.moveTo(-1.0, 0)
        tri.lineTo(1.0, 0)
        tri.lineTo(0, 0.9)
        tri.lineTo(-1.0, 0)
        const rg = new THREE.ExtrudeGeometry(tri, { depth: 2.2, bevelEnabled: false })
        rg.translate(0, 0, -1.1)
        scaleUV(rg, 1.5)
        const rm = new THREE.Mesh(rg, M.roofRed)
        rm.rotation.y = Math.PI / 2
        rm.castShadow = true
        add(rm, wellX, 3.15, wellZ)
        // відро на мотузці
        const ropeM = cylinder(0.015, 0.015, 1.5, 6, M.rope, wellX, 1.9, wellZ, 1)
        const bucket = cylinder(0.2, 0.15, 0.3, 12, M.woodMat('#a08a6c'), wellX, 1.05, wellZ, 1)
        bucket.userData.rope = ropeM
        addCollider(wellX, 0.55, wellZ, 2.6, 1.1, 2.6)
    }

    /* ---------- ринкові ятки з навісами ---------- */
    const awningTex = (() =>
    {
        const c = document.createElement('canvas')
        c.width = 256
        c.height = 128
        const g = c.getContext('2d')
        for(let i = 0; i < 8; i++)
        {
            g.fillStyle = i % 2 ? '#e8dfc9' : '#9b2c2c'
            g.fillRect(i * 32, 0, 32, 128)
        }
        const t = new THREE.CanvasTexture(c)
        t.colorSpace = THREE.SRGBColorSpace
        t.anisotropy = 8
        return t
    })()
    const awningMat = new THREE.MeshStandardMaterial({ map: awningTex, roughness: 0.95, side: THREE.DoubleSide })
    const appleMat = new THREE.MeshStandardMaterial({ color: '#b3261e', roughness: 0.4 })
    const breadMat = new THREE.MeshStandardMaterial({ color: '#b98542', roughness: 0.8 })
    const makeStall = (x, z, ry, goods) =>
    {
        const s = new THREE.Group()
        s.position.set(x, 0, z)
        s.rotation.y = ry
        group.add(s)
        box(3.2, 0.12, 1.3, M.woodMat(), 0, 0.95, 0, 2, s)
        box(3.0, 0.9, 1.1, M.woodMat('#8d7662'), 0, 0.45, 0, 2, s)
        for(const sx of [-1, 1]) for(const sz of [-1, 1]) box(0.12, 2.6, 0.12, M.woodMat('#6e5c4c'), sx * 1.55, 1.3, sz * 0.62, 2, s)
        const aw = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 1.9), awningMat)
        aw.rotation.x = -Math.PI / 2 + 0.38
        aw.position.set(0, 2.55, 0.05)
        aw.castShadow = true
        s.add(aw)
        // товар
        for(let i = 0; i < 9; i++)
        {
            if(goods === 'apples')
            {
                const a = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), appleMat)
                a.position.set(-1.0 + (i % 5) * 0.5 + (i > 4 ? 0.2 : 0), 1.1 + (i > 4 ? 0.12 : 0), (i > 4 ? 0.15 : -0.15))
                a.castShadow = true
                s.add(a)
            }
            else
            {
                const b = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), breadMat)
                b.scale.set(1.6, 0.8, 0.9)
                b.position.set(-1.0 + (i % 5) * 0.5, 1.12 + (i > 4 ? 0.12 : 0), (i > 4 ? 0.2 : -0.2))
                b.castShadow = true
                s.add(b)
            }
        }
        addCollider(x, 0.55, z, 3.2, 1.1, 1.3, ry)
    }
    makeStall(-8.5, 12.5, 0.15, 'apples')
    makeStall(-12, 3.5, Math.PI / 2 - 0.1, 'bread')

    /* ---------- смолоскипи й жаровні (шейдер вогню + PointLight) ---------- */
    const flameGeo = new THREE.PlaneGeometry(1, 1)
    flameGeo.translate(0, 0.5, 0)
    let flameSeed = 0
    const addFlame = (x, y, z, size = [0.5, 0.95], intensity = 1) =>
    {
        const mat = createFlameMaterial(timeUniform, flameSeed++ * 0.37, size, intensity)
        const f = new THREE.Mesh(flameGeo, mat)
        f.position.set(x, y, z)
        f.userData.noAO = true
        f.renderOrder = 5
        group.add(f)
        flames.push(mat)
        return f
    }
    const addFireLight = (x, y, z, power = 18, distance = 16) =>
    {
        const l = new THREE.PointLight('#ff9a3d', power, distance, 2)
        l.position.set(x, y, z)
        l.userData.base = power
        l.userData.phase = Math.random() * 100
        group.add(l)
        lights.push(l)
        return l
    }
    const torch = (x, y, z, withLight = true) =>
    {
        cylinder(0.05, 0.06, 0.9, 8, M.woodMat('#6b543e'), x, y, z, 1)
        cylinder(0.16, 0.08, 0.2, 10, M.bronze, x, y + 0.5, z, 1)
        addFlame(x, y + 0.55, z, [0.48, 0.95], 1)
        smokeSources.push(new THREE.Vector3(x, Y0 + y + 1.6, z))
        if(withLight) addFireLight(x, y + 1.0, z)
    }
    // у проході брами (два), біля входу в донжон (два), на зовнішніх опорах мосту (два)
    torch(-2.05, 3.2, hz - 0.4)
    torch(2.05, 3.2, hz - 0.4)
    torch(-2.5, 3.0, keepZ + 6.0, false)
    torch(2.5, 3.0, keepZ + 6.0)
    // смолоскипи на стовпах біля дальнього краю моста (на березі, не над водою)
    for(const s of [-1, 1])
    {
        box(0.35, 1.5, 0.35, M.woodMat('#6e5c4c'), s * 3.3, 0.75, hz + 15.8, 2)
        torch(s * 3.3, 2.0, hz + 15.8, false)
    }

    // жаровня на триніжку у дворі
    const brazier = (x, z) =>
    {
        for(let k = 0; k < 3; k++)
        {
            const a = (k / 3) * Math.PI * 2
            const leg = cylinder(0.04, 0.04, 1.15, 6, M.darkIron, x + Math.cos(a) * 0.35, 0.55, z + Math.sin(a) * 0.35, 1)
            leg.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25)
        }
        const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M.darkIron)
        bowl.material = M.darkIron.clone()
        bowl.material.side = THREE.DoubleSide
        bowl.castShadow = true
        add(bowl, x, 1.1, z)
        const embers = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), new THREE.MeshBasicMaterial({ color: '#ff5a14' }))
        embers.rotation.x = -Math.PI / 2
        add(embers, x, 1.0, z)
        addFlame(x, 1.15, z, [0.9, 1.5], 1.15)
        addFireLight(x, 1.9, z, 40, 22)
        smokeSources.push(new THREE.Vector3(x, Y0 + 2.6, z))
        addCollider(x, 0.6, z, 0.8, 1.2, 0.8)
    }
    brazier(-6, -1)
    brazier(8, -1)

    /* ---------- фізичні декорації (бочки, ящики, тюки) ---------- */
    const barrelGeo = (() =>
    {
        const pts = []
        for(let i = 0; i <= 10; i++)
        {
            const t = i / 10
            pts.push(new THREE.Vector2(0.3 + Math.sin(t * Math.PI) * 0.1, t * 0.9 - 0.45))
        }
        const g = new THREE.LatheGeometry(pts, 16)
        const uv = g.attributes.uv
        for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 1.2)
        return g
    })()
    const bandGeo = new THREE.TorusGeometry(0.385, 0.018, 6, 20)
    const makeBarrel = (x, z, y = 0.45) =>
    {
        const g = new THREE.Group()
        const body = new THREE.Mesh(barrelGeo, M.woodMat('#b09070'))
        body.castShadow = body.receiveShadow = true
        g.add(body)
        for(const by of [-0.28, 0.28])
        {
            const band = new THREE.Mesh(bandGeo, M.darkIron)
            band.rotation.x = Math.PI / 2
            band.position.y = by
            band.scale.setScalar(by === 0 ? 1 : 0.97)
            g.add(band)
        }
        const lid = new THREE.Mesh(new THREE.CircleGeometry(0.31, 16), M.woodMat('#8a6c4c'))
        lid.rotation.x = -Math.PI / 2
        lid.position.y = 0.45
        g.add(lid)
        g.position.set(x, y, z)
        group.add(g)
        dynamicProps.push({ object: g, half: [0.34, 0.45, 0.34], mass: 25 })
        return g
    }
    const makeCrate = (x, z, y, s = 0.9, ry = 0) =>
    {
        const c = makeBox(s, s, s, M.woodMat('#a68a6a'), 1.4)
        for(const [w, h, d] of [[s + 0.04, 0.08, 0.1], [0.1, 0.08, s + 0.04]])
        {
            const strap = makeBox(w, h, d, M.frame, 1)
            strap.position.y = s / 2 - 0.02
            c.add(strap)
        }
        c.position.set(x, y + s / 2, z)
        c.rotation.y = ry
        group.add(c)
        dynamicProps.push({ object: c, half: [s / 2, s / 2, s / 2], mass: 18 })
        return c
    }
    const makeHay = (x, z, y, ry = 0) =>
    {
        const c = makeBox(1.1, 0.55, 0.6, M.hay, 0.7)
        c.position.set(x, y + 0.275, z)
        c.rotation.y = ry
        group.add(c)
        dynamicProps.push({ object: c, half: [0.55, 0.275, 0.3], mass: 10 })
        return c
    }
    // піраміда ящиків біля ринку, бочки біля донжона, тюки у стайні
    makeCrate(-12.5, 12.5, 0, 0.9, 0.2)
    makeCrate(-11.5, 12.8, 0, 0.9, -0.1)
    makeCrate(-12.0, 12.6, 0.9, 0.9, 0.3)
    makeBarrel(-10.4, 13.3)
    makeBarrel(-9.6, 13.9)
    makeBarrel(8.6, -4.6)
    makeBarrel(9.5, -4.4)
    makeBarrel(9.0, -5.3)
    makeBarrel(9.05, -4.85, 1.35)
    makeCrate(-3.8, -3.2, 0, 0.8, 0.4)
    makeCrate(-3.0, -3.5, 0, 0.8, 0.1)
    for(let i = 0; i < 4; i++) makeHay(stX - 3.0 + (i % 2) * 1.2, stZ + 1.5 + Math.floor(i / 2) * 0.7, (i > 1 ? 0.55 : 0), 0.1 * i)
    makeHay(stX - 2.6, stZ + 1.6, 1.1, 0.4)

    /* ---------- маршрути вартових (по верху стін між вежами) ---------- */
    const wy = H
    patrols.push({ a: [-hx + 6.0, wy, -hz + 0.8], b: [hx - 6.0, wy, -hz + 0.8], speed: 1.15 })       // північна стіна
    patrols.push({ a: [-hx + 0.8, wy, -hz + 6.0], b: [-hx + 0.8, wy, hz - 6.0], speed: 1.0 })        // західна
    patrols.push({ a: [hx - 0.8, wy, hz - 6.0], b: [hx - 0.8, wy, -hz + 6.0], speed: 1.05 })         // східна
    patrols.push({ a: [-hx + 6.0, wy, hz - 0.8], b: [-9.0, wy, hz - 0.8], speed: 0.95 })             // південна (ліворуч від брами)

    /* ---------- зубці/вікна/бійниці — збірка InstancedMesh ---------- */
    const dummy = new THREE.Object3D()
    for(const key of Object.keys(merlonSets))
    {
        const { mat, list } = merlonSets[key]
        const geo = worldUV(new THREE.BoxGeometry(1.5, 1.3, 0.8), 1.5, 1.3, 0.8, 3, 3)
        const mesh = new THREE.InstancedMesh(geo, mat, list.length)
        list.forEach(([x, y, z, ry], i) =>
        {
            dummy.position.set(x, y, z)
            dummy.rotation.set(0, ry, 0)
            dummy.updateMatrix()
            mesh.setMatrixAt(i, dummy.matrix)
        })
        mesh.castShadow = mesh.receiveShadow = true
        group.add(mesh)
    }
    {
        const frameGeo = worldUV(new THREE.BoxGeometry(1.5, 2.5, 0.34), 1.5, 2.5, 0.34, 3, 3)
        const glassGeo = new THREE.BoxGeometry(0.95, 1.85, 0.36)
        const frames = new THREE.InstancedMesh(frameGeo, M.darkStone, winList.length)
        const panes = new THREE.InstancedMesh(glassGeo, glass, winList.length)
        winList.forEach(([x, y, z, ry], i) =>
        {
            dummy.position.set(x, y, z)
            dummy.rotation.set(0, ry, 0)
            dummy.scale.set(1, 1, 1)
            dummy.updateMatrix()
            frames.setMatrixAt(i, dummy.matrix)
            panes.setMatrixAt(i, dummy.matrix)
        })
        frames.castShadow = true
        group.add(frames, panes)

        const slitGeo = new THREE.BoxGeometry(0.28, 1.5, 0.3)
        const slits = new THREE.InstancedMesh(slitGeo, slitGlass, slitList.length)
        slitList.forEach(([x, y, z, ry], i) =>
        {
            dummy.position.set(x, y, z)
            dummy.rotation.set(0, ry, 0)
            dummy.updateMatrix()
            slits.setMatrixAt(i, dummy.matrix)
        })
        group.add(slits)
    }

    return {
        group, colliders, lights, flames, flags, smokeSources, dynamicProps, patrols, glass,
        portcullis, setBridge,
        bridge: { pivot: bridgePivot, length: bridgeLen, z: hz + 3.6, y: 0.25 + Y0 },
        keepZ, stable: { x: stX, z: stZ }
    }
}
