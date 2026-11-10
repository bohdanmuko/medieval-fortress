import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { terrainHeight, Y0 } from './world.js'
import { worldUV } from './geo.js'

/**
 * Фізика (cannon-es). Усе, що рухається за законами фізики:
 *   - снаряди (кам'яні ядра) — пул з 24 куль;
 *   - мур-барикада із цегли (InstancedMesh, ~150 тіл, «засинають» у спокої і прокидаються від удару);
 *   - бочки, ящики, тюки сіна, що стоять у замку й таборі;
 *   - кінематичний міст: тіло слідує за анімованим мостом, тому ядра відбиваються від піднятого настилу.
 * Статичні колайдери (стіни, вежі, брама) приходять із castle.js / camp.js — це спрощені коробки.
 * Рельєф — Heightfield, що будується з тієї самої функції terrainHeight(), що й візуальний рельєф.
 */
export class Physics
{
    constructor()
    {
        this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })
        this.world.broadphase = new CANNON.NaiveBroadphase()
        this.world.allowSleep = true
        this.world.solver.iterations = 16
        const dc = this.world.defaultContactMaterial
        dc.friction = 0.65
        dc.restitution = 0.06
        dc.contactEquationStiffness = 1e8
        dc.contactEquationRelaxation = 3

        this.props = []        // { body, object, offsetY }
        this.projectiles = []
        this.walls = []        // { mesh, bodies, init }
        this.onImpact = null   // (position, strength) => void
        this.lastImpact = 0
        this.accumulator = 0
        this.stats = { bodies: 0, awake: 0 }
    }

    /* ---------- рельєф ---------- */
    addTerrain(half = 128, elementSize = 1.28)
    {
        const n = Math.round((half * 2) / elementSize) + 1
        const x0 = -half
        const z0 = half
        const data = []
        for(let i = 0; i < n; i++)
        {
            const column = new Array(n)
            for(let j = 0; j < n; j++) column[j] = terrainHeight(x0 + i * elementSize, z0 - j * elementSize)
            data.push(column)
        }
        const body = new CANNON.Body({ mass: 0 })
        body.addShape(new CANNON.Heightfield(data, { elementSize }))
        // Heightfield лежить у площині XY, висота — по Z. Повертаємо на -90° навколо X: Z → +Y, Y → -Z
        body.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
        body.position.set(x0, 0, z0)
        this.world.addBody(body)
        this.terrainBody = body
    }

    /* ---------- статичні коробки ---------- */
    addStaticBoxes(list)
    {
        for(const c of list)
        {
            const body = new CANNON.Body({ mass: 0 })
            body.addShape(new CANNON.Box(new CANNON.Vec3(c.hx, c.hy, c.hz)))
            body.position.set(c.x, c.y, c.z)
            body.quaternion.setFromEuler(0, c.ry || 0, 0)
            this.world.addBody(body)
        }
    }

    /* ---------- динамічні предмети ---------- */
    addProp(prop, offsetY = 0)
    {
        const { object, half, mass } = prop
        object.updateWorldMatrix(true, false)
        const p = new THREE.Vector3()
        const q = new THREE.Quaternion()
        object.getWorldPosition(p)
        object.getWorldQuaternion(q)
        const body = new CANNON.Body({
            mass,
            shape: new CANNON.Box(new CANNON.Vec3(half[0] * 0.98, half[1] * 0.98, half[2] * 0.98)),
            sleepSpeedLimit: 0.25,
            sleepTimeLimit: 0.8,
            linearDamping: 0.05,
            angularDamping: 0.1
        })
        body.position.set(p.x, p.y, p.z)
        body.quaternion.set(q.x, q.y, q.z, q.w)
        this.world.addBody(body)
        body.sleep()
        this.props.push({ body, object, offsetY, home: { p: p.clone(), q: q.clone() } })
    }

    /* ---------- стіна з цегли ---------- */
    /**
     * Створює стіну cols × rows цеглин (розкладка «в перев'язку»), стоїть на землі у точці center, повернута на yaw.
     * Графіка — один InstancedMesh; кожна цегла = Box-тіло.
     */
    addBrickWall(material, { x, z, yaw, cols, rows, size = [1.2, 0.6, 0.8], mass = 20 })
    {
        const [bw, bh, bd] = size
        const geo = worldUV(new THREE.BoxGeometry(bw, bh, bd), bw, bh, bd, 2.4, 2.4)
        const items = []
        for(let r = 0; r < rows; r++)
        {
            const n = r % 2 ? cols - 1 : cols
            const off = (r % 2) * (bw / 2)
            for(let c = 0; c < n; c++) items.push([-cols * bw / 2 + bw / 2 + off + c * bw, bh / 2 + r * bh + 0.004])
        }
        const mesh = new THREE.InstancedMesh(geo, material, items.length)
        mesh.castShadow = mesh.receiveShadow = true
        mesh.frustumCulled = false
        const ground = terrainHeight(x, z)
        const cosY = Math.cos(yaw)
        const sinY = Math.sin(yaw)
        const bodies = []
        const init = []
        const shape = new CANNON.Box(new CANNON.Vec3(bw / 2 - 0.004, bh / 2 - 0.004, bd / 2 - 0.004))
        items.forEach(([lx, ly], i) =>
        {
            const body = new CANNON.Body({
                mass, shape,
                sleepSpeedLimit: 0.3, sleepTimeLimit: 0.6,
                linearDamping: 0.05, angularDamping: 0.05
            })
            // локальний X стіни → світ: поворот навколо Y
            const px = x + lx * cosY
            const pz = z - lx * sinY
            body.position.set(px, ground + ly, pz)
            body.quaternion.setFromEuler(0, yaw, 0)
            this.world.addBody(body)
            body.sleep()
            bodies.push(body)
            init.push({ p: body.position.clone(), q: body.quaternion.clone() })
        })
        const wall = { mesh, bodies, init, needsSync: true }
        this.walls.push(wall)
        this.syncWall(wall, true)
        return mesh
    }

    syncWall(wall, force = false)
    {
        const m = new THREE.Matrix4()
        const q = new THREE.Quaternion()
        const p = new THREE.Vector3()
        const s = new THREE.Vector3(1, 1, 1)
        let dirty = force
        wall.bodies.forEach((b, i) =>
        {
            if(!force && b.sleepState === CANNON.Body.SLEEPING) return
            p.set(b.position.x, b.position.y, b.position.z)
            q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w)
            m.compose(p, q, s)
            wall.mesh.setMatrixAt(i, m)
            dirty = true
        })
        if(dirty) wall.mesh.instanceMatrix.needsUpdate = true
    }

    /* ---------- снаряди ---------- */
    createProjectiles(scene, material, count = 24)
    {
        const geo = new THREE.SphereGeometry(0.5, 28, 20)
        const shape = new CANNON.Sphere(0.5)
        for(let i = 0; i < count; i++)
        {
            const mesh = new THREE.Mesh(geo, material)
            mesh.castShadow = mesh.receiveShadow = true
            mesh.visible = false
            scene.add(mesh)
            const body = new CANNON.Body({ mass: 260, shape, linearDamping: 0.005, angularDamping: 0.2, sleepSpeedLimit: 0.4, sleepTimeLimit: 1.5 })
            body.position.set(0, -500, 0)
            this.world.addBody(body)
            body.sleep()
            body.addEventListener('collide', (e) =>
            {
                const impact = Math.abs(e.contact.getImpactVelocityAlongNormal())
                const now = performance.now()
                if(impact > 3.5 && now - this.lastImpact > 70 && this.onImpact)
                {
                    this.lastImpact = now
                    this.onImpact(new THREE.Vector3(body.position.x, body.position.y, body.position.z), impact)
                }
            })
            this.projectiles.push({ mesh, body, ttl: 0 })
        }
        this.nextProjectile = 0
    }

    fire(position, velocity)
    {
        const slot = this.projectiles[this.nextProjectile]
        this.nextProjectile = (this.nextProjectile + 1) % this.projectiles.length
        const b = slot.body
        b.wakeUp()
        b.position.set(position.x, position.y, position.z)
        b.velocity.set(velocity.x, velocity.y, velocity.z)
        b.angularVelocity.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        b.quaternion.set(0, 0, 0, 1)
        b.force.setZero()
        b.torque.setZero()
        slot.ttl = 40
        slot.mesh.visible = true
        slot.mesh.position.copy(position)
    }

    /* ---------- кінематичний міст ---------- */
    addBridge(bridge)
    {
        const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC })
        body.addShape(new CANNON.Box(new CANNON.Vec3(2.15, 0.18, bridge.length / 2)), new CANNON.Vec3(0, 0, bridge.length / 2))
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.1, 0.5, bridge.length / 2)), new CANNON.Vec3(2.0, 0.6, bridge.length / 2))
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.1, 0.5, bridge.length / 2)), new CANNON.Vec3(-2.0, 0.6, bridge.length / 2))
        body.position.set(0, bridge.y, bridge.z)
        this.world.addBody(body)
        this.bridgeBody = body
        this.bridge = bridge
    }

    /* ---------- скидання сцени ---------- */
    reset()
    {
        for(const wall of this.walls)
        {
            wall.bodies.forEach((b, i) =>
            {
                b.position.copy(wall.init[i].p)
                b.quaternion.copy(wall.init[i].q)
                b.velocity.setZero()
                b.angularVelocity.setZero()
                b.sleep()
            })
            this.syncWall(wall, true)
        }
        for(const p of this.props)
        {
            p.body.position.set(p.home.p.x, p.home.p.y, p.home.p.z)
            p.body.quaternion.set(p.home.q.x, p.home.q.y, p.home.q.z, p.home.q.w)
            p.body.velocity.setZero()
            p.body.angularVelocity.setZero()
            p.body.sleep()
            this.syncProp(p, true)
        }
        for(const s of this.projectiles)
        {
            s.body.position.set(0, -500, 0)
            s.body.velocity.setZero()
            s.body.sleep()
            s.mesh.visible = false
            s.ttl = 0
        }
    }

    syncProp(p, force = false)
    {
        if(!force && p.body.sleepState === CANNON.Body.SLEEPING) return
        p.object.position.set(p.body.position.x, p.body.position.y - p.offsetY, p.body.position.z)
        p.object.quaternion.set(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w)
    }

    /* ---------- крок ---------- */
    step(dt)
    {
        // міст: тіло повторює орієнтацію візуального моста
        if(this.bridgeBody)
        {
            const a = this.bridge.pivot.rotation.x
            this.bridgeBody.quaternion.setFromEuler(a, 0, 0)
        }
        this.world.step(1 / 60, dt, 4)

        let awake = 0
        for(const wall of this.walls)
        {
            this.syncWall(wall)
            for(const b of wall.bodies) if(b.sleepState !== CANNON.Body.SLEEPING) awake++
        }
        for(const p of this.props)
        {
            this.syncProp(p)
            if(p.body.sleepState !== CANNON.Body.SLEEPING) awake++
        }
        for(const s of this.projectiles)
        {
            if(!s.mesh.visible) continue
            s.mesh.position.set(s.body.position.x, s.body.position.y, s.body.position.z)
            s.mesh.quaternion.set(s.body.quaternion.x, s.body.quaternion.y, s.body.quaternion.z, s.body.quaternion.w)
            s.ttl -= dt
            awake++
            if(s.ttl <= 0 || s.body.position.y < -20)
            {
                s.mesh.visible = false
                s.body.position.set(0, -500, 0)
                s.body.sleep()
            }
        }
        this.stats.bodies = this.world.bodies.length
        this.stats.awake = awake
    }
}

export { Y0 }
