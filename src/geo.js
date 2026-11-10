import * as THREE from 'three'

/**
 * Допоміжні функції геометрії.
 */

// Перераховує UV для BoxGeometry так, щоб текстура мала однаковий розмір у метрах на всіх гранях.
// tileU/tileV — скільки метрів займає одне повторення текстури.
export const worldUV = (geometry, w, h, d, tileU = 3, tileV = tileU) =>
{
    const uv = geometry.attributes.uv
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]] // +x, -x, +y, -y, +z, -z
    for(let f = 0; f < 6; f++)
    {
        for(let v = 0; v < 4; v++)
        {
            const i = f * 4 + v
            uv.setXY(i, uv.getX(i) * dims[f][0] / tileU, uv.getY(i) * dims[f][1] / tileV)
        }
    }
    uv.needsUpdate = true
    return geometry
}

// ExtrudeGeometry / ShapeGeometry мають UV у метрах — просто ділимо на розмір плитки
export const scaleUV = (geometry, tile = 3) =>
{
    const uv = geometry.attributes.uv
    for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / tile, uv.getY(i) / tile)
    uv.needsUpdate = true
    return geometry
}

export const makeBox = (w, h, d, material, tileU = 3, tileV = tileU) =>
{
    const mesh = new THREE.Mesh(worldUV(new THREE.BoxGeometry(w, h, d), w, h, d, tileU, tileV), material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
}

export const shadowAll = (object, cast = true, receive = true) =>
{
    object.traverse((child) =>
    {
        if(child.isMesh)
        {
            child.castShadow = cast
            child.receiveShadow = receive
        }
    })
    return object
}

export const place = (object, x, y, z, ry = 0) =>
{
    object.position.set(x, y, z)
    object.rotation.y = ry
    return object
}

// Прямокутник із заокругленими кутами (для рову): Shape
export const roundedRectShape = (hx, hz, r) =>
{
    const s = new THREE.Shape()
    s.moveTo(-hx + r, -hz)
    s.lineTo(hx - r, -hz)
    s.absarc(hx - r, -hz + r, r, -Math.PI / 2, 0, false)
    s.lineTo(hx, hz - r)
    s.absarc(hx - r, hz - r, r, 0, Math.PI / 2, false)
    s.lineTo(-hx + r, hz)
    s.absarc(-hx + r, hz - r, r, Math.PI / 2, Math.PI, false)
    s.lineTo(-hx, -hz + r)
    s.absarc(-hx + r, -hz + r, r, Math.PI, Math.PI * 1.5, false)
    return s
}

// Циліндричний «стрижень» між двома точками (для ланцюгів, балок): масштабується в update
export const stretchBetween = (mesh, a, b) =>
{
    const dir = new THREE.Vector3().subVectors(b, a)
    const len = dir.length()
    mesh.position.copy(a).addScaledVector(dir, 0.5)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
    mesh.scale.set(1, len, 1)
}
