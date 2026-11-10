import * as THREE from 'three'
import { Y0, terrainHeight, makeRandom } from './world.js'
import { makeBox, stretchBetween } from './geo.js'
import { patchFlagMaterial, createFlameMaterial } from './shaders.js'

/**
 * Табір облоги: требушет (анімація + пуск снаряда у фізичний світ), намети, багаття,
 * частокіл, віз. Усе зібрано з примітивів.
 */

const G = 9.82

/**
 * Балістика: початкова швидкість, щоб снаряд, запущений під кутом theta із точки P, влучив у точку T.
 *   v² = g·d² / ( 2·cos²θ · (d·tanθ − Δy) ),   d — горизонтальна відстань, Δy = T.y − P.y
 */
export const solveLaunch = (P, T, theta = 0.85) =>
{
    const dx = T.x - P.x
    const dz = T.z - P.z
    const d = Math.hypot(dx, dz)
    const dy = T.y - P.y
    const denom = 2 * Math.cos(theta) ** 2 * (d * Math.tan(theta) - dy)
    const v = Math.sqrt((G * d * d) / Math.max(denom, 1e-3))
    return new THREE.Vector3(
        (dx / d) * v * Math.cos(theta),
        v * Math.sin(theta),
        (dz / d) * v * Math.cos(theta)
    )
}

export class Trebuchet
{
    constructor(M, x, z, target)
    {
        this.group = new THREE.Group()
        this.group.position.set(x, Y0, z)
        // повертаємо так, щоб локальна вісь +X дивилась на ціль
        this.target = target.clone()
        this.group.rotation.y = -Math.atan2(target.z - z, target.x - x)

        const wood = M.woodMat('#9b8068')
        const darkWood = M.woodMat('#6d5846')
        const g = this.group

        const add = (mesh, x, y, z, parent = g) => { mesh.position.set(x, y, z); parent.add(mesh); return mesh }

        // основа: дві поздовжні балки й три поперечні
        for(const s of [-1, 1]) add(makeBox(8.4, 0.5, 0.5, darkWood, 2), 0, 0.25, s * 1.7)
        for(const px of [-3.4, 0, 3.4]) add(makeBox(0.5, 0.45, 3.9, darkWood, 2), px, 0.62, 0)
        // A-подібні стійки: нахилені балки від основи до осі
        const beamGeo = new THREE.BoxGeometry(0.38, 1, 0.38)
        const pivotY = 7
        for(const s of [-1, 1])
        {
            for(const bx of [-2.8, 2.8])
            {
                const beam = new THREE.Mesh(beamGeo, wood)
                beam.castShadow = beam.receiveShadow = true
                stretchBetween(beam, new THREE.Vector3(bx, 0.5, s * 1.7), new THREE.Vector3(0, pivotY, s * 1.35))
                g.add(beam)
            }
            add(makeBox(5.6, 0.28, 0.28, darkWood, 2), 0, 2.2, s * 1.62) // розпірка
        }
        // вісь (залізний циліндр уздовж Z)
        const axle = add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 3.8, 14), M.darkIron), 0, pivotY, 0)
        axle.rotation.x = Math.PI / 2
        axle.castShadow = true

        // рухома частина: arm обертається навколо осі в площині XY
        this.arm = new THREE.Group()
        this.arm.position.set(0, pivotY, 0)
        g.add(this.arm)
        const armLong = 8.0
        const armShort = 2.4
        const beam = makeBox(armLong + armShort, 0.42, 0.34, wood, 2)
        beam.position.x = (armLong - armShort) / 2
        this.arm.add(beam)
        for(const bx of [-1.6, 1.0, 3.6, 6.2])
        {
            const band = makeBox(0.16, 0.5, 0.42, M.darkIron, 1)
            band.position.x = bx
            this.arm.add(band)
        }
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.05, 8, 14), M.darkIron)
        ring.position.x = armLong
        this.arm.add(ring)
        this.armLong = armLong
        this.armShort = armShort

        // противага: ящик із каменем на двох тягах
        this.cw = new THREE.Group()
        g.add(this.cw)
        const cwBox = makeBox(2.1, 2.0, 1.7, M.rockMat, 1.6)
        cwBox.position.y = -1.0
        this.cw.add(cwBox)
        const cwFrame = makeBox(2.3, 0.18, 1.9, M.darkIron, 1)
        cwFrame.position.y = 0.0
        this.cw.add(cwFrame)
        this.rods = [-1, 1].map(() =>
        {
            const r = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6), M.darkIron)
            g.add(r)
            return r
        })

        // праща: дві мотузки до снаряда
        this.slingRopes = [-1, 1].map(() =>
        {
            const r = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 5), M.rope)
            g.add(r)
            return r
        })
        this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), M.rockMat)
        this.ball.castShadow = true
        g.add(this.ball)

        // лебідка
        this.winch = new THREE.Group()
        this.winch.position.set(-3.6, 1.4, 0)
        g.add(this.winch)
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 3.2, 12), wood)
        drum.rotation.x = Math.PI / 2
        drum.castShadow = true
        this.winch.add(drum)
        for(let k = 0; k < 4; k++)
        {
            const spoke = makeBox(2.0, 0.12, 0.12, darkWood, 1)
            spoke.rotation.z = (k / 4) * Math.PI
            spoke.position.z = 1.7
            const spoke2 = spoke.clone()
            spoke2.position.z = -1.7
            this.winch.add(spoke, spoke2)
        }
        for(const s of [-1, 1]) add(makeBox(0.3, 2.4, 0.3, darkWood, 2), -3.6, 1.2, s * 1.9)

        // жолоб, у якому лежить снаряд
        add(makeBox(3.4, 0.2, 0.9, darkWood, 2), 1.4, 0.55, 0)

        // стан автомата
        this.state = 'ready'
        this.time = 0
        this.phi0 = THREE.MathUtils.degToRad(230)
        this.phi1 = THREE.MathUtils.degToRad(-55)
        this.phiRelease = THREE.MathUtils.degToRad(98)
        this.released = false
        this.ballVisible = true
        this.onRelease = null
        this.phi = this.phi0
        this.theta = 0.85
        this.pose()
    }

    // Колайдер основи (світові координати)
    get colliders()
    {
        const p = this.group.position
        const ry = this.group.rotation.y
        return [{ x: p.x, y: p.y + 0.4, z: p.z, hx: 4.2, hy: 0.4, hz: 2.0, ry }]
    }

    fire()
    {
        if(this.state !== 'ready') return false
        this.state = 'swing'
        this.time = 0
        this.released = false
        return true
    }

    // Позиція кінця плеча й пращі для кута phi
    pose()
    {
        const phi = this.phi
        this.arm.rotation.z = phi
        const c = Math.cos(phi)
        const s = Math.sin(phi)
        const tip = new THREE.Vector3(c * this.armLong, this.arm.position.y + s * this.armLong, 0)
        const shortEnd = new THREE.Vector3(-c * this.armShort, this.arm.position.y - s * this.armShort, 0)
        this.tip = tip

        // противага висить вертикально під коротким кінцем
        this.cw.position.set(shortEnd.x, shortEnd.y - 1.0, 0)
        this.rods.forEach((rod, i) =>
        {
            const z = i === 0 ? -0.65 : 0.65
            stretchBetween(rod, new THREE.Vector3(shortEnd.x, shortEnd.y, z * 0.4), new THREE.Vector3(shortEnd.x, shortEnd.y - 1.0, z))
        })

        // праща: напрямок «ззаду» руху кінця → плавно повертається у напрямок пуску
        const trail = new THREE.Vector3(-s, c, 0)
        const launch = new THREE.Vector3(Math.cos(this.theta), Math.sin(this.theta), 0)
        const k = THREE.MathUtils.smoothstep(this.phi, THREE.MathUtils.degToRad(190), this.phiRelease)
        // phi зменшується під час пуску → k росте від 0 до 1, коли phi → phiRelease
        const kk = 1 - THREE.MathUtils.smoothstep(this.phi, this.phiRelease, THREE.MathUtils.degToRad(190))
        void k
        const dir = trail.clone().lerp(launch, kk).normalize()
        const ballPos = tip.clone().addScaledVector(dir, 3.0)
        ballPos.y = Math.max(ballPos.y, 0.62 + 0.5)
        if(this.state === 'ready' || (this.state === 'recover' && this.phi > THREE.MathUtils.degToRad(200)))
        {
            // у спокої снаряд лежить у жолобі
            ballPos.set(1.8, 1.2, 0)
        }
        this.ball.position.copy(ballPos)
        this.ball.visible = this.ballVisible
        this.slingRopes.forEach((rope, i) =>
        {
            const z = i === 0 ? -0.18 : 0.18
            stretchBetween(rope, new THREE.Vector3(tip.x, tip.y, z * 0.2), new THREE.Vector3(ballPos.x, ballPos.y, z))
        })
    }

    update(dt)
    {
        if(this.state === 'swing')
        {
            this.time += dt
            const T = 1.7
            const u = Math.min(this.time / T, 1)
            const s = u * u * (1.6 - 0.6 * u) // розгін
            this.phi = this.phi0 + (this.phi1 - this.phi0) * s
            this.winch.rotation.z -= dt * 0.3
            if(!this.released && this.phi <= this.phiRelease)
            {
                this.released = true
                this.ballVisible = false
                this.pose()
                const P = this.group.localToWorld(this.ball.position.clone())
                if(this.onRelease) this.onRelease(P, this.target, this.theta)
            }
            if(u >= 1)
            {
                this.state = 'recover'
                this.time = 0
            }
        }
        else if(this.state === 'recover')
        {
            this.time += dt
            const T = 6
            const u = Math.min(this.time / T, 1)
            const e = u * u * (3 - 2 * u)
            this.phi = this.phi1 + (this.phi0 - this.phi1) * e
            this.winch.rotation.z += dt * 2.2 * Math.sin(u * Math.PI)
            if(u > 0.8) this.ballVisible = true
            if(u >= 1)
            {
                this.state = 'ready'
                this.phi = this.phi0
                this.ballVisible = true
            }
        }
        this.pose()
    }
}

/**
 * Намети, багаття, частокіл, віз. Повертає групу й дані для фізики/ефектів.
 */
export const createCamp = (M, timeUniform, treb) =>
{
    const group = new THREE.Group()
    const flames = []
    const lights = []
    const smokeSources = []
    const colliders = []
    const dynamicProps = []
    const rand = makeRandom(77)

    const addFlame = (x, y, z, size, intensity, seed) =>
    {
        const geo = new THREE.PlaneGeometry(1, 1)
        geo.translate(0, 0.5, 0)
        const mat = createFlameMaterial(timeUniform, seed, size, intensity)
        const f = new THREE.Mesh(geo, mat)
        f.position.set(x, y, z)
        f.userData.noAO = true
        f.renderOrder = 5
        group.add(f)
        flames.push(mat)
    }

    // намет-павільйон: циліндр + конус + вхід + флюгер-прапорець
    const tent = (x, z, r, mat, ry, flagIdx) =>
    {
        const y = Y0
        const t = new THREE.Group()
        t.position.set(x, y, z)
        t.rotation.y = ry
        const wall = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.5, 20, 1, true), mat)
        wall.position.y = 0.75
        wall.castShadow = wall.receiveShadow = true
        t.add(wall)
        const roof = new THREE.Mesh(new THREE.ConeGeometry(r * 1.2, 2.3, 20, 1), mat)
        roof.position.y = 1.5 + 1.15
        roof.castShadow = roof.receiveShadow = true
        t.add(roof)
        const floor = new THREE.Mesh(new THREE.CircleGeometry(r, 20), M.hay)
        floor.rotation.x = -Math.PI / 2
        floor.position.y = 0.03
        t.add(floor)
        const door = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.35), new THREE.MeshStandardMaterial({ color: '#1a1410', roughness: 1, side: THREE.DoubleSide }))
        door.position.set(0, 0.68, r - 0.02)
        t.add(door)
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.8, 8), M.woodMat('#7a6350'))
        pole.position.y = 3.95 + 0.4
        t.add(pole)
        const fm = new THREE.MeshStandardMaterial({ map: M.banners[flagIdx], side: THREE.DoubleSide, roughness: 0.8 })
        patchFlagMaterial(fm, timeUniform, 1.5, 0.12)
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.9, 24, 8), fm)
        flag.position.set(0.82, 4.9, 0)
        flag.castShadow = true
        t.add(flag)
        group.add(t)
        colliders.push({ x, y: y + 1.2, z, hx: r * 0.65, hy: 1.2, hz: r * 0.65, ry: ry + Math.PI / 4 })
        colliders.push({ x, y: y + 1.2, z, hx: r * 0.65, hy: 1.2, hz: r * 0.65, ry })
    }
    tent(-46, 33, 2.3, M.tentRed, 0.5, 1)
    tent(-50, 41, 2.0, M.canvasCloth, 1.2, 1)
    tent(-44, 52, 2.4, M.tentRed, 2.4, 1)

    // багаття: коло каміння, колоди, полум'я, світло, дим, триніжок із казаном
    const fireX = -42
    const fireZ = 40.5
    {
        for(let k = 0; k < 9; k++)
        {
            const a = (k / 9) * Math.PI * 2
            const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), M.rockMat)
            rock.position.set(fireX + Math.cos(a) * 0.8, Y0 + 0.14, fireZ + Math.sin(a) * 0.8)
            rock.scale.set(1, 0.7, 1)
            rock.rotation.set(rand() * 3, rand() * 3, rand() * 3)
            rock.castShadow = true
            group.add(rock)
        }
        for(let k = 0; k < 4; k++)
        {
            const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 1.2, 8), M.woodMat('#3a2a20'))
            const a = (k / 4) * Math.PI + 0.3
            log.rotation.set(Math.PI / 2 - 0.25, 0, a)
            log.rotation.order = 'YXZ'
            log.rotation.set(0, a, Math.PI / 2 - 0.2)
            log.position.set(fireX, Y0 + 0.2, fireZ)
            log.castShadow = true
            group.add(log)
        }
        const embers = new THREE.Mesh(new THREE.CircleGeometry(0.6, 16), new THREE.MeshBasicMaterial({ color: '#ff4a10' }))
        embers.rotation.x = -Math.PI / 2
        embers.position.set(fireX, Y0 + 0.08, fireZ)
        group.add(embers)
        addFlame(fireX, Y0 + 0.2, fireZ, [1.15, 1.9], 1.2, 3.1)
        addFlame(fireX + 0.15, Y0 + 0.2, fireZ - 0.1, [0.8, 1.35], 1.0, 4.7)
        const l = new THREE.PointLight('#ff8f3a', 60, 28, 2)
        l.position.set(fireX, Y0 + 1.4, fireZ)
        l.userData.base = 60
        l.userData.phase = 9
        group.add(l)
        lights.push(l)
        smokeSources.push(new THREE.Vector3(fireX, Y0 + 2.2, fireZ))
        // триніжок із казаном
        for(let k = 0; k < 3; k++)
        {
            const a = (k / 3) * Math.PI * 2 + 0.5
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.0, 6), M.darkIron)
            leg.position.set(fireX + Math.cos(a) * 0.35, Y0 + 0.95, fireZ + Math.sin(a) * 0.35)
            leg.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3)
            group.add(leg)
        }
        const pot = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M.darkIron)
        pot.rotation.x = Math.PI
        pot.position.set(fireX, Y0 + 0.9, fireZ)
        pot.castShadow = true
        group.add(pot)
        // лави-колоди
        for(const a of [0.6, 2.5, 4.6])
        {
            const bench = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 2.0, 10), M.woodMat('#8a6c50'))
            bench.rotation.z = Math.PI / 2
            bench.rotation.order = 'YXZ'
            bench.rotation.set(0, -a + Math.PI / 2, Math.PI / 2)
            bench.position.set(fireX + Math.cos(a) * 2.6, Y0 + 0.2, fireZ + Math.sin(a) * 2.6)
            bench.castShadow = bench.receiveShadow = true
            group.add(bench)
        }
        colliders.push({ x: fireX, y: Y0 + 0.4, z: fireZ, hx: 0.8, hy: 0.4, hz: 0.8, ry: 0 })
    }

    // частокіл (InstancedMesh загострених паль): на півночі, заході й півдні табору
    {
        const stakeGeo = new THREE.CylinderGeometry(0.1, 0.16, 2.4, 7)
        stakeGeo.translate(0, 1.2, 0)
        const tip = new THREE.ConeGeometry(0.1, 0.5, 7)
        tip.translate(0, 2.65, 0)
        const pts = []
        const line = (x0, z0, x1, z1) =>
        {
            const n = Math.floor(Math.hypot(x1 - x0, z1 - z0) / 0.42)
            for(let i = 0; i <= n; i++) pts.push([x0 + (x1 - x0) * (i / n), z0 + (z1 - z0) * (i / n)])
        }
        line(-56, 24, -43, 24)
        line(-56, 24, -56, 60)
        line(-56, 60, -32, 60)
        const mat = M.woodMat('#8a7058')
        const stakes = new THREE.InstancedMesh(stakeGeo, mat, pts.length)
        const tips = new THREE.InstancedMesh(tip, mat, pts.length)
        const d = new THREE.Object3D()
        pts.forEach(([x, z], i) =>
        {
            const y = terrainHeight(x, z) - 0.15
            const h = 0.75 + rand() * 0.5
            d.position.set(x + (rand() - 0.5) * 0.1, y, z + (rand() - 0.5) * 0.1)
            d.scale.set(1, h, 1)
            d.rotation.set((rand() - 0.5) * 0.1, rand() * 6, (rand() - 0.5) * 0.1)
            d.updateMatrix()
            stakes.setMatrixAt(i, d.matrix)
            d.scale.set(1, 1, 1)
            d.position.y = y + (h - 1) * 2.4
            d.updateMatrix()
            tips.setMatrixAt(i, d.matrix)
        })
        stakes.castShadow = stakes.receiveShadow = true
        tips.castShadow = true
        group.add(stakes, tips)
    }

    // віз із бочками
    {
        const cart = new THREE.Group()
        cart.position.set(-35, Y0, 55)
        cart.rotation.y = -0.4
        const bed = makeBox(3.2, 0.18, 1.7, M.woodMat('#8d7662'), 2)
        bed.position.y = 1.0
        cart.add(bed)
        for(const s of [-1, 1])
        {
            const side = makeBox(3.2, 0.5, 0.1, M.woodMat('#7b6552'), 2)
            side.position.set(0, 1.35, s * 0.82)
            cart.add(side)
            const wheel = new THREE.Group()
            wheel.position.set(0, 0.75, s * 1.0)
            const rim = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.07, 8, 24), M.woodMat('#6b5644'))
            wheel.add(rim)
            for(let k = 0; k < 6; k++)
            {
                const sp = makeBox(1.4, 0.08, 0.08, M.woodMat('#6b5644'), 1)
                sp.rotation.z = (k / 6) * Math.PI
                wheel.add(sp)
            }
            const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 10), M.darkIron)
            hub.rotation.x = Math.PI / 2
            wheel.add(hub)
            cart.add(wheel)
        }
        const shaft = makeBox(2.2, 0.1, 0.1, M.woodMat('#6b5644'), 1)
        shaft.position.set(2.5, 0.9, 0.3)
        shaft.rotation.z = 0.1
        cart.add(shaft)
        group.add(cart)
        colliders.push({ x: -35, y: Y0 + 0.9, z: 55, hx: 1.7, hy: 0.7, hz: 1.0, ry: -0.4 })
    }

    // штандарт табору — високий стовп із синім прапором
    {
        const x = -43
        const z = 28
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 9, 10), M.woodMat('#7b6552'))
        pole.position.set(x, Y0 + 4.5, z)
        pole.castShadow = true
        group.add(pole)
        const fm = new THREE.MeshStandardMaterial({ map: M.banners[1], side: THREE.DoubleSide, roughness: 0.8 })
        patchFlagMaterial(fm, timeUniform, 3.2, 0.3)
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.0, 32, 12), fm)
        flag.position.set(x + 1.68, Y0 + 7.8, z)
        flag.castShadow = true
        group.add(flag)
    }

    // бочки/ящики з фізикою
    {
        const barrelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.9, 14)
        const mk = (x, z, y) =>
        {
            const m = new THREE.Mesh(barrelGeo, M.woodMat('#b09070'))
            m.castShadow = m.receiveShadow = true
            m.position.set(x, y, z)
            group.add(m)
            dynamicProps.push({ object: m, half: [0.34, 0.45, 0.34], mass: 25, offsetY: 0 })
        }
        mk(-33, 52, Y0 + 0.45)
        mk(-37, 56.5, Y0 + 0.45)
        mk(-36.4, 57, Y0 + 0.45)
        for(let i = 0; i < 4; i++)
        {
            const c = makeBox(0.9, 0.9, 0.9, M.woodMat('#a68a6a'), 1.4)
            c.position.set(-31.5 + (i % 2) * 0.95, Y0 + 0.45 + Math.floor(i / 2) * 0.9, 33)
            group.add(c)
            dynamicProps.push({ object: c, half: [0.45, 0.45, 0.45], mass: 18, offsetY: 0 })
        }
    }

    return { group, flames, lights, smokeSources, colliders, dynamicProps, fire: new THREE.Vector3(fireX, Y0, fireZ) }
}
