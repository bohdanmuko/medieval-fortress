import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { terrainHeight, roadPoints, Y0 } from './world.js'

/**
 * Складні (імпортовані) моделі формату glTF:
 *   - Soldier.glb — скелетна модель воїна (SkinnedMesh, кістки Mixamo) з клипами Idle / Walk / Run
 *   - Horse.glb   — кінь на morph targets (анімація «галопу» = зміна ваг морф-цілей)
 * Обидва файли — з прикладів three.js (r170): https://github.com/mrdoob/three.js/tree/r170/examples/models/gltf
 */
export const loadModels = async (manager) =>
{
    const loader = new GLTFLoader(manager)
    const [soldier, horse] = await Promise.all([
        loader.loadAsync('./models/Soldier.glb'),
        loader.loadAsync('./models/Horse.glb')
    ])
    return { soldier, horse }
}

/**
 * Воїн. Клонуємо через SkeletonUtils.clone (звичайний .clone() ламає зв'язок кісток зі шкірою),
 * кожен клон має власний AnimationMixer, тому може грати свою анімацію.
 */
export class Soldier
{
    constructor(gltf, { tint = '#ffffff', scale = 1 } = {})
    {
        this.root = new THREE.Group()
        this.model = SkeletonUtils.clone(gltf.scene)
        this.model.scale.setScalar(scale)
        this.model.rotation.y = Math.PI // модель Soldier.glb дивиться в −z; рух і yaw у проєкті рахуються для «вперед = +z»
        this.model.traverse((child) =>
        {
            if(!child.isMesh) return
            child.castShadow = true
            child.receiveShadow = true
            child.frustumCulled = false // скелет рухається — обмежувальна сфера початкової пози не підходить
            child.material = child.material.clone()
            if(child.material.map && child.name.includes('Mesh')) child.material.color.set(tint)
        })
        this.root.add(this.model)

        this.mixer = new THREE.AnimationMixer(this.model)
        this.actions = {}
        for(const clip of gltf.animations) this.actions[clip.name] = this.mixer.clipAction(clip)
        this.current = null
        this.play('Idle')
        this.mixer.update(Math.random() * 2) // розсинхронізуємо клони, щоб не рухались «хором»
    }

    play(name, fade = 0.35)
    {
        const next = this.actions[name]
        if(!next || next === this.current) return
        next.reset().fadeIn(fade).play()
        if(this.current) this.current.fadeOut(fade)
        this.current = next
        this.state = name
    }

    update(dt) { this.mixer.update(dt) }
}

/**
 * Вартовий, що ходить між точками A і B (світові координати) і зупиняється на кінцях
 */
export class Patrol
{
    constructor(soldier, a, b, speed = 1.1)
    {
        this.soldier = soldier
        this.a = new THREE.Vector3(...a)
        this.b = new THREE.Vector3(...b)
        this.speed = speed
        this.t = Math.random()
        this.dir = 1
        this.wait = 0
        this.length = this.a.distanceTo(this.b)
        this.yaw = 0
        this.apply()
    }

    apply()
    {
        const p = this.soldier.root.position.lerpVectors(this.a, this.b, this.t)
        void p
        const target = this.dir > 0 ? Math.atan2(this.b.x - this.a.x, this.b.z - this.a.z) : Math.atan2(this.a.x - this.b.x, this.a.z - this.b.z)
        // плавний поворот (найкоротшою дугою)
        let d = target - this.yaw
        d = Math.atan2(Math.sin(d), Math.cos(d))
        this.yaw += d * 0.15
        this.soldier.root.rotation.y = this.yaw
    }

    update(dt)
    {
        if(this.wait > 0)
        {
            this.wait -= dt
            this.soldier.play('Idle')
            if(this.wait <= 0) this.dir *= -1
        }
        else
        {
            this.soldier.play('Walk')
            this.t += (this.dir * this.speed * dt) / this.length
            if(this.t >= 1 || this.t <= 0)
            {
                this.t = THREE.MathUtils.clamp(this.t, 0, 1)
                this.wait = 2 + Math.random() * 2
            }
        }
        this.apply()
        this.soldier.update(dt)
    }
}

/**
 * Кінь. Mesh із morph targets: AnimationMixer змінює morphTargetInfluences → «біг».
 * Їздить туди-сюди по дорозі на пагорб (використовуємо ті самі точки, що й шейдер рельєфу).
 */
export class Horse
{
    constructor(gltf, { stand = false } = {})
    {
        const src = gltf.scene.children[0]
        this.mesh = src.clone()
        this.mesh.material = src.material.clone()
        this.mesh.material.flatShading = true
        this.mesh.material.roughness = 0.75
        this.mesh.material.metalness = 0
        this.mesh.castShadow = this.mesh.receiveShadow = true
        this.mesh.frustumCulled = false
        // нормалізація розміру: висота в холці ≈ 1.6 м; центруємо по довжині
        const s = 1.62 / 183
        this.mesh.scale.setScalar(s)
        this.mesh.position.set(-2 * s, -0.8 * s, 26 * s)
        // у файлі голова коня дивиться в +Z: «вперед» збігається з +Z, як і у воїна
        this.root = new THREE.Group()
        this.root.add(this.mesh)

        this.mixer = new THREE.AnimationMixer(this.mesh)
        const action = this.mixer.clipAction(gltf.animations[0])
        action.setDuration(0.8).play()
        this.action = action
        this.stand = stand
        if(stand)
        {
            // у стайні кінь стоїть: усереднюємо всі фази галопу → ноги збираються під тулубом (поза спокою)
            action.stop()
            const n = this.mesh.morphTargetInfluences.length
            this.mesh.morphTargetInfluences.fill(1 / n)
        }
        this.t = 0
        this.yaw = 0
        this.pause = 0
        this.dir = 1
        this.speed = 6.5
        this.s = 0
        this.road = roadPoints.slice(38).map(([x, z]) => new THREE.Vector3(x, 0, z))
        this.segLen = []
        this.total = 0
        for(let i = 0; i < this.road.length - 1; i++)
        {
            const l = this.road[i].distanceTo(this.road[i + 1])
            this.segLen.push(l)
            this.total += l
        }
        this.s = this.total * 0.5
    }

    sample(s, out)
    {
        let acc = 0
        for(let i = 0; i < this.segLen.length; i++)
        {
            if(s <= acc + this.segLen[i] || i === this.segLen.length - 1)
            {
                const t = THREE.MathUtils.clamp((s - acc) / this.segLen[i], 0, 1)
                return out.lerpVectors(this.road[i], this.road[i + 1], t)
            }
            acc += this.segLen[i]
        }
        return out
    }

    update(dt)
    {
        if(this.stand) return
        const p = new THREE.Vector3()
        if(this.pause > 0)
        {
            this.pause -= dt
            this.action.timeScale = 0.0001
        }
        else
        {
            this.action.timeScale = 1
            this.s += this.dir * this.speed * dt
            if(this.s > this.total - 1 || this.s < 1)
            {
                this.dir *= -1
                this.pause = 1.2
            }
        }
        this.sample(this.s, p)
        const ahead = this.sample(this.s + this.dir * 1.5, new THREE.Vector3())
        const target = Math.atan2(ahead.x - p.x, ahead.z - p.z)
        let d = target - this.yaw
        d = Math.atan2(Math.sin(d), Math.cos(d))
        this.yaw += d * Math.min(1, dt * 5)
        this.root.position.set(p.x, terrainHeight(p.x, p.z) + 0.05, p.z)
        this.root.rotation.y = this.yaw
        this.mixer.update(dt)
    }
}

export { Y0 }
