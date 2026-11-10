import * as THREE from 'three'
import { Y0, makeRandom } from './world.js'

/**
 * Прості ефекти без важких систем часток:
 *   Puffs — пул спрайтів: дим із труб/смолоскипів і пил від ударів ядер
 *   Birds — зграя птахів (InstancedMesh + махання крилами у вершинному шейдері)
 *   createStars — зорі (THREE.Points), видимі вночі
 */
export class Puffs
{
    constructor(scene, texture, count = 220)
    {
        this.items = []
        for(let i = 0; i < count; i++)
        {
            const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0, color: '#9a968f' })
            const s = new THREE.Sprite(mat)
            s.visible = false
            s.userData.noAO = true
            scene.add(s)
            this.items.push({ sprite: s, life: 0, max: 1, vel: new THREE.Vector3(), grow: 1, base: 1, peak: 0.2 })
        }
        this.cursor = 0
        this.sources = []
        this.acc = []
    }

    spawn(pos, vel, size, life, color, peak = 0.22, grow = 2.4)
    {
        const it = this.items[this.cursor]
        this.cursor = (this.cursor + 1) % this.items.length
        it.life = it.max = life
        it.vel.copy(vel)
        it.base = size
        it.grow = grow
        it.peak = peak
        it.sprite.position.copy(pos)
        it.sprite.material.color.set(color)
        it.sprite.material.rotation = Math.random() * 6
        it.sprite.visible = true
    }

    addSources(list) { for(const s of list) { this.sources.push(s); this.acc.push(Math.random()) } }

    // пил від удару: розліт у сторони + вгору
    burst(pos, strength)
    {
        const n = Math.min(14, 5 + Math.floor(strength / 3))
        for(let i = 0; i < n; i++)
        {
            const a = Math.random() * Math.PI * 2
            const v = new THREE.Vector3(Math.cos(a) * (1 + Math.random() * 3), 0.8 + Math.random() * 2.2, Math.sin(a) * (1 + Math.random() * 3))
            this.spawn(pos, v, 0.9 + Math.random() * 0.8, 1.2 + Math.random() * 1.2, '#b8a98d', 0.4, 3.2)
        }
    }

    update(dt, wind, nightBoost)
    {
        // викиди диму
        this.sources.forEach((src, i) =>
        {
            this.acc[i] += dt * 1.1
            while(this.acc[i] > 1)
            {
                this.acc[i] -= 1
                this.spawn(src, new THREE.Vector3(0.1 + wind * 0.4, 0.9 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3), 0.5 + Math.random() * 0.3, 5 + Math.random() * 2, nightBoost > 0.5 ? '#6f6c68' : '#aaa59d', 0.18, 4.5)
            }
        })
        for(const it of this.items)
        {
            if(it.life <= 0) continue
            it.life -= dt
            if(it.life <= 0) { it.sprite.visible = false; continue }
            const k = 1 - it.life / it.max
            it.sprite.position.addScaledVector(it.vel, dt)
            it.vel.x += wind * dt * 0.5
            it.vel.multiplyScalar(1 - dt * 0.35)
            const s = it.base * (1 + k * it.grow)
            it.sprite.scale.set(s, s, 1)
            it.sprite.material.opacity = it.peak * Math.sin(Math.min(1, k * 1.15) * Math.PI) * (1 - k * 0.3)
        }
    }
}

export const createBirds = (timeUniform, count = 14) =>
{
    const g = new THREE.BufferGeometry()
    const v = new Float32Array([
        0, 0, 0.5, -0.07, 0, -0.3, 0.07, 0, -0.3,          // тіло
        0, 0, 0.1, -0.95, 0, -0.15, -0.08, 0, -0.32,       // ліве крило
        0, 0, 0.1, 0.08, 0, -0.32, 0.95, 0, -0.15          // праве крило
    ])
    g.setAttribute('position', new THREE.BufferAttribute(v, 3))
    g.computeVertexNormals()
    const mat = new THREE.MeshBasicMaterial({ color: '#15171a', side: THREE.DoubleSide })
    mat.onBeforeCompile = (shader) =>
    {
        shader.uniforms.uTime = timeUniform
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
float ph = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.21;
transformed.y += sin(uTime * 9.0 + ph) * abs(position.x) * 0.55;`)
    }
    const mesh = new THREE.InstancedMesh(g, mat, count)
    mesh.frustumCulled = false
    mesh.userData.noAO = true
    const rand = makeRandom(5)
    const birds = Array.from({ length: count }, () => ({
        r: 24 + rand() * 40, h: 22 + rand() * 26, a: rand() * 6.28, w: (0.12 + rand() * 0.12) * (rand() > 0.5 ? 1 : -1),
        cx: (rand() - 0.5) * 20, cz: (rand() - 0.5) * 20, s: 1.3 + rand() * 0.8
    }))
    const d = new THREE.Object3D()
    const update = (dt) =>
    {
        birds.forEach((b, i) =>
        {
            b.a += b.w * dt
            const x = b.cx + Math.cos(b.a) * b.r
            const z = b.cz + Math.sin(b.a) * b.r
            d.position.set(x, Y0 + b.h + Math.sin(b.a * 3 + i) * 2, z)
            d.rotation.set(0, Math.atan2(-Math.sin(b.a) * Math.sign(b.w), Math.cos(b.a) * Math.sign(b.w)), Math.sin(b.a * 5) * 0.2)
            d.scale.setScalar(b.s)
            d.updateMatrix()
            mesh.setMatrixAt(i, d.matrix)
        })
        mesh.instanceMatrix.needsUpdate = true
    }
    update(0)
    return { mesh, update }
}

export const createStars = (count = 1800) =>
{
    const rand = makeRandom(31)
    const pos = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    for(let i = 0; i < count; i++)
    {
        const u = rand() * 2 - 1
        const a = rand() * Math.PI * 2
        const y = Math.abs(u) * 0.98 + 0.02
        const r = Math.sqrt(1 - y * y)
        pos.set([Math.cos(a) * r * 1400, y * 1400, Math.sin(a) * r * 1400], i * 3)
        const t = 0.6 + rand() * 0.4
        col.set([t, t, 0.85 + rand() * 0.15], i * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const m = new THREE.PointsMaterial({ size: 2.0, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false })
    const stars = new THREE.Points(g, m)
    stars.frustumCulled = false
    stars.renderOrder = -2
    return stars
}
