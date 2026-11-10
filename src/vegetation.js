import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { terrainHeight, distToRoad, sdBox, fbm, makeRandom, Y0, MOAT } from './world.js'
import { patchWindSway } from './shaders.js'

/**
 * Дерева (сосни й дуби), кущі й каміння — все через InstancedMesh.
 * Геометрія дерева збирається злиттям кількох примітивів (mergeGeometries) в одну → один draw call на вид.
 * Крони гойдаються у вершинному шейдері (patchWindSway).
 */
export const createVegetation = (M, timeUniform, exclude = () => false) =>
{
    const group = new THREE.Group()
    group.name = 'vegetation'
    const rand = makeRandom(2024)

    const scaleUVs = (g, k) =>
    {
        const uv = g.attributes.uv
        for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k)
        return g
    }
    const tr = (g, x, y, z) => { g.translate(x, y, z); return g }

    /* ----- геометрія сосни ----- */
    const pineTrunk = scaleUVs(new THREE.CylinderGeometry(0.16, 0.3, 4.2, 7), 1)
    pineTrunk.translate(0, 2.1, 0)
    const pineCrown = mergeGeometries([
        tr(scaleUVs(new THREE.ConeGeometry(2.3, 3.2, 9, 1), 3), 0, 3.2 + 1.6, 0),
        tr(scaleUVs(new THREE.ConeGeometry(1.9, 2.8, 9, 1), 3), 0, 5.0 + 1.4, 0),
        tr(scaleUVs(new THREE.ConeGeometry(1.45, 2.5, 9, 1), 3), 0, 6.6 + 1.25, 0),
        tr(scaleUVs(new THREE.ConeGeometry(0.95, 2.2, 9, 1), 3), 0, 8.0 + 1.1, 0)
    ])

    /* ----- геометрія дуба: стовбур + кілька «грудок» крони з шумом на вершинах ----- */
    const oakTrunk = scaleUVs(new THREE.CylinderGeometry(0.28, 0.5, 3.4, 7), 1)
    oakTrunk.translate(0, 1.7, 0)
    const blob = (r, x, y, z, seed) =>
    {
        const g = new THREE.IcosahedronGeometry(r, 2)
        const p = g.attributes.position
        for(let i = 0; i < p.count; i++)
        {
            const n = 1 + (fbm(p.getX(i) * 1.7 + seed, p.getZ(i) * 1.7 + p.getY(i), 2)) * 0.28
            p.setXYZ(i, p.getX(i) * n, p.getY(i) * n * 0.85, p.getZ(i) * n)
        }
        g.computeVertexNormals()
        g.translate(x, y, z)
        return scaleUVs(g, 2)
    }
    const oakCrown = mergeGeometries([
        blob(2.3, 0, 5.4, 0, 1), blob(1.7, 1.5, 4.7, 0.6, 2), blob(1.6, -1.4, 4.9, -0.5, 3),
        blob(1.5, 0.3, 4.6, -1.5, 4), blob(1.5, -0.5, 6.4, 0.9, 5)
    ])

    /* ----- матеріали (клони з власним шейдером вітру) ----- */
    const trunkMat = M.woodMat('#8d7a68')
    const pineMat = M.foliage.clone()
    pineMat.color.set('#86c47c')
    patchWindSway(pineMat, timeUniform, 1.1)
    const oakMat = M.foliage.clone()
    oakMat.color.set('#a6d27a')
    patchWindSway(oakMat, timeUniform, 1.5)

    /* ----- розстановка ----- */
    const pines = []
    const oaks = []
    const step = 6.2
    const slopeAt = (x, z) =>
    {
        const e = 2
        const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z)
        const dz = terrainHeight(x, z + e) - terrainHeight(x, z - e)
        return Math.hypot(dx, dz) / (2 * e)
    }
    for(let gx = -250; gx <= 250; gx += step)
        for(let gz = -250; gz <= 250; gz += step)
        {
            const x = gx + (rand() - 0.5) * step * 0.95
            const z = gz + (rand() - 0.5) * step * 0.95
            const r = Math.hypot(x, z)
            if(r < 60 || r > 250) continue
            if(exclude(x, z)) continue
            if(distToRoad(x, z) < 6) continue
            // щільність лісу: плями (шум) + рідше біля плато
            const density = 0.5 + 0.5 * fbm(x * 0.02 + 3, z * 0.02 - 9, 3) - 0.25 * (1 - Math.min(1, (r - 60) / 40))
            if(rand() > density * 0.95) continue
            if(slopeAt(x, z) > 0.6) continue
            const y = terrainHeight(x, z)
            const s = 0.75 + rand() * 0.9
            const high = y > Y0 * 0.55
            const entry = { x, y: y - 0.1, z, s, ry: rand() * 6.28, tilt: (rand() - 0.5) * 0.08 }
            ;(high || rand() < 0.45 ? pines : oaks).push(entry)
        }

    const buildSet = (list, geo, mat, name, colorFn) =>
    {
        const mesh = new THREE.InstancedMesh(geo, mat, list.length)
        mesh.name = name
        const d = new THREE.Object3D()
        const c = new THREE.Color()
        list.forEach((t, i) =>
        {
            d.position.set(t.x, t.y, t.z)
            d.rotation.set(t.tilt, t.ry, t.tilt * 0.5)
            d.scale.set(t.s * (0.9 + 0.2 * Math.sin(t.ry)), t.s, t.s)
            d.updateMatrix()
            mesh.setMatrixAt(i, d.matrix)
            if(colorFn) mesh.setColorAt(i, colorFn(c, t))
        })
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.frustumCulled = false // InstancedMesh: одна сфера на всі інстанси, а дерева розкидані по всій карті
        group.add(mesh)
        return mesh
    }
    buildSet(pines, pineTrunk, trunkMat, 'pine-trunks')
    buildSet(pines, pineCrown, pineMat, 'pine-crowns', (c) => c.setHSL(0.33 + (rand() - 0.5) * 0.04, 0.45, 0.62 + (rand() - 0.5) * 0.16))
    buildSet(oaks, oakTrunk, trunkMat, 'oak-trunks')
    buildSet(oaks, oakCrown, oakMat, 'oak-crowns', (c) => c.setHSL(0.24 + (rand() - 0.5) * 0.06, 0.5, 0.62 + (rand() - 0.5) * 0.2))

    /* ----- каміння: на схилах і вздовж обох берегів рову ----- */
    const rockGeo = (() =>
    {
        const g = new THREE.IcosahedronGeometry(1, 2)
        const p = g.attributes.position
        for(let i = 0; i < p.count; i++)
        {
            const n = 1 + fbm(p.getX(i) * 2.1 + 5, p.getZ(i) * 2.1 + p.getY(i) * 1.3, 3) * 0.42
            p.setXYZ(i, p.getX(i) * n, p.getY(i) * n * 0.72, p.getZ(i) * n)
        }
        g.computeVertexNormals()
        const uv = g.attributes.uv
        for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 2)
        return g
    })()
    const rocks = []
    for(let i = 0; i < 4000 && rocks.length < 320; i++)
    {
        const x = (rand() - 0.5) * 520
        const z = (rand() - 0.5) * 520
        const sd = sdBox(x, z)
        const bank = (sd > MOAT.inner - 0.5 && sd < MOAT.inner + 0.9) || (sd > MOAT.outer - 0.9 && sd < MOAT.outer + 0.9)
        const r = Math.hypot(x, z)
        const slope = r > 60 && slopeAt(x, z) > 0.42 && r < 280
        if(!(bank && rand() < 0.35) && !(slope && rand() < 0.5)) continue
        if(Math.abs(x) < 7 && z > 18 && z < 42) continue // міст
        if(exclude(x, z) || (r > 60 && distToRoad(x, z) < 3.5)) continue
        const s = bank ? 0.35 + rand() * 0.8 : 0.7 + rand() * 2.4
        rocks.push({ x, y: terrainHeight(x, z) - s * 0.2, z, s, ry: rand() * 6.28 })
    }
    {
        const mesh = new THREE.InstancedMesh(rockGeo, M.rockMat, rocks.length)
        const d = new THREE.Object3D()
        rocks.forEach((t, i) =>
        {
            d.position.set(t.x, t.y, t.z)
            d.rotation.set(rand() * 0.4, t.ry, rand() * 0.4)
            d.scale.set(t.s * (0.9 + rand() * 0.5), t.s * (0.7 + rand() * 0.4), t.s * (0.9 + rand() * 0.5))
            d.updateMatrix()
            mesh.setMatrixAt(i, d.matrix)
        })
        mesh.castShadow = mesh.receiveShadow = true
        mesh.frustumCulled = false
        group.add(mesh)
    }

    /* ----- кущі й польові квіти біля дороги ----- */
    {
        const bushGeo = blob(0.8, 0, 0.55, 0, 9)
        const bushMat = M.foliage.clone()
        bushMat.color.set('#8fc070')
        patchWindSway(bushMat, timeUniform, 1.0)
        const bushes = []
        for(let i = 0; i < 2500 && bushes.length < 260; i++)
        {
            const x = (rand() - 0.5) * 360
            const z = (rand() - 0.5) * 360
            const r = Math.hypot(x, z)
            if(r < 58 || r > 170 || exclude(x, z)) continue
            const dr = distToRoad(x, z)
            if(dr < 3.2 || dr > 14 || slopeAt(x, z) > 0.5) continue
            bushes.push({ x, z, s: 0.7 + rand() * 0.9, ry: rand() * 6 })
        }
        const mesh = new THREE.InstancedMesh(bushGeo, bushMat, bushes.length)
        const d = new THREE.Object3D()
        bushes.forEach((t, i) =>
        {
            d.position.set(t.x, terrainHeight(t.x, t.z) - 0.1, t.z)
            d.rotation.set(0, t.ry, 0)
            d.scale.setScalar(t.s)
            d.updateMatrix()
            mesh.setMatrixAt(i, d.matrix)
        })
        mesh.castShadow = mesh.receiveShadow = true
        mesh.frustumCulled = false
        group.add(mesh)
    }

    return { group, stats: { pines: pines.length, oaks: oaks.length, rocks: rocks.length } }
}
