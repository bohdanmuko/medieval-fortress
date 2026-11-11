import * as THREE from 'three'
import { terrainHeight, distToRoad, FOOT, WATER_Y, MOAT } from './world.js'
import { roundedRectShape } from './geo.js'
import { createTerrainMaterial, createWaterMaterial } from './shaders.js'

/**
 * Рельєф (PlaneGeometry зі зміщеними вершинами) + вода рову.
 * Висота береться з world.js, тому фізика використовує ту саму функцію.
 */
export const createTerrain = (M) =>
{
    const SIZE = 760
    const SEG = 400
    const geometry = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG)
    geometry.rotateX(-Math.PI / 2) // одразу кладемо в площину XZ — modelMatrix лишається одиничною

    const pos = geometry.attributes.position
    const road = new Float32Array(pos.count)
    const uv = geometry.attributes.uv
    for(let i = 0; i < pos.count; i++)
    {
        const x = pos.getX(i)
        const z = pos.getZ(i)
        // на самому краю карти опускаємо рельєф, щоб не було видно «обрізу» (фізики там немає, тож розбіжності не страшні)
        const edge = 1 - 0.88 * THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), 285, 378)
        pos.setY(i, terrainHeight(x, z) * edge)
        // маска дороги: 1 на осі, плавно до 0 на краях
        road[i] = 1 - THREE.MathUtils.smoothstep(distToRoad(x, z), 2.4, 4.8)
        uv.setXY(i, x / 7, z / 7) // для нормал-мапи
    }
    geometry.setAttribute('aRoad', new THREE.BufferAttribute(road, 1))
    geometry.computeVertexNormals()

    const material = createTerrainMaterial(M.tex, WATER_Y)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.name = 'terrain'

    // Вода: кільце між зовнішнім і внутрішнім заокругленими прямокутниками (збігається з geometry рову у terrainHeight)
    const outer = roundedRectShape(FOOT.hx + MOAT.outer + 0.2, FOOT.hz + MOAT.outer + 0.2, MOAT.outer + 0.2)
    const hole = roundedRectShape(FOOT.hx + MOAT.inner - 0.2, FOOT.hz + MOAT.inner - 0.2, MOAT.inner - 0.2)
    outer.holes.push(hole)
    const waterGeometry = new THREE.ShapeGeometry(outer, 24)
    waterGeometry.rotateX(-Math.PI / 2) // ShapeGeometry лежить у XY; XY → XZ (y вгору)
    const waterMaterial = createWaterMaterial(M.tex.waterNormal)
    const water = new THREE.Mesh(waterGeometry, waterMaterial)
    water.position.y = WATER_Y
    water.name = 'moat-water'

    return { mesh, water, waterMaterial }
}
