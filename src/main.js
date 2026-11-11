import * as THREE from 'three'
import GUI from 'lil-gui'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Sky } from 'three/addons/objects/Sky.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

import { Y0, terrainHeight, FOOT } from './world.js'
import { createMaterials } from './materials.js'
import { createTerrain } from './terrain.js'
import { createCastle } from './castle.js'
import { createCamp, Trebuchet, solveLaunch } from './camp.js'
import { createVegetation } from './vegetation.js'
import { loadModels, Soldier, Patrol, Horse } from './models.js'
import { Physics } from './physics.js'
import { Puffs, createBirds, createStars } from './effects.js'
import { createCloudDome, GradeShader } from './shaders.js'

/* =====================================================================
   0. DOM, параметри, пресети якості
   ===================================================================== */
const canvas = document.querySelector('canvas.webgl')
const $ = (id) => document.getElementById(id)
const urlParams = new URLSearchParams(location.search)

const QUALITY = {
    low:    { name: 'Низька',     pr: 1,    shadow: 1024, samples: 0, ao: false, bloom: false, trees: false },
    medium: { name: 'Середня',    pr: 1.25, shadow: 2048, samples: 4, ao: true,  bloom: true,  trees: true },
    high:   { name: 'Висока',     pr: 2,    shadow: 4096, samples: 4, ao: true,  bloom: true,  trees: true },
    ultra:  { name: 'Максимальна', pr: 2.5, shadow: 4096, samples: 8, ao: true,  bloom: true,  trees: true }
}
const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra']

const params = {
    quality: urlParams.get('q') && QUALITY[urlParams.get('q')] ? urlParams.get('q') : 'high',
    adaptive: !urlParams.get('q'),
    hour: 16.8,
    autoTime: false,
    timeSpeed: 0.35,
    exposure: 0.62,
    fog: 0.0030,
    clouds: 0.5,
    wind: 1,
    bloom: 0.55,
    ao: 1.0,
    vignette: 0.32,
    grain: 0.02,
    contrast: 1.05,
    saturation: 1.08,
    torches: 1,
    shadows: true
}

const sizes = { width: window.innerWidth, height: window.innerHeight }
const timeU = { value: 0 }      // спільний uniform часу для всіх шейдерів

/* =====================================================================
   1. Рендерер
   ===================================================================== */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false })
renderer.setSize(sizes.width, sizes.height)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = params.exposure
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.info.autoReset = false
const maxAniso = renderer.capabilities.getMaxAnisotropy()

const scene = new THREE.Scene()
scene.fog = new THREE.FogExp2('#b9cde0', params.fog)

const camera = new THREE.PerspectiveCamera(48, sizes.width / sizes.height, 0.3, 2600)
camera.position.set(76, Y0 + 40, 100)
scene.add(camera)

const controls = new OrbitControls(camera, canvas)
controls.target.set(0, Y0 + 8, 0)
controls.enableDamping = true
controls.dampingFactor = 0.06
controls.minDistance = 4
controls.maxDistance = 260
controls.maxPolarAngle = Math.PI * 0.495
controls.update()

/* =====================================================================
   2. Небо, сонце/місяць, зорі, хмари, довкілля (IBL)
   ===================================================================== */
const sky = new Sky()
sky.scale.setScalar(450000)
sky.userData.noAO = true
scene.add(sky)
// Окрема копія неба — лише для генерації карти довкілля (PMREM) для PBR-відблисків
const envScene = new THREE.Scene()
const skyEnv = new Sky()
skyEnv.scale.setScalar(450000)
envScene.add(skyEnv)
const pmrem = new THREE.PMREMGenerator(renderer)
let envTarget = null

for(const s of [sky, skyEnv])
{
    const u = s.material.uniforms
    u.turbidity.value = 4.5
    u.rayleigh.value = 2.1
    u.mieCoefficient.value = 0.0045
    u.mieDirectionalG.value = 0.82
}

const stars = createStars()
stars.userData.noAO = true
scene.add(stars)
const clouds = createCloudDome()
clouds.mesh.userData.noAO = true
scene.add(clouds.mesh)

// Одне джерело спрямованого світла: вдень — сонце, вночі — місяць (тіні від обох)
const sun = new THREE.DirectionalLight('#fff3dc', 4)
sun.castShadow = true
sun.shadow.camera.left = -80
sun.shadow.camera.right = 80
sun.shadow.camera.top = 80
sun.shadow.camera.bottom = -80
sun.shadow.camera.near = 10
sun.shadow.camera.far = 420
sun.shadow.bias = -0.00035
sun.shadow.normalBias = 0.045
sun.target.position.set(0, Y0 + 4, 0)
scene.add(sun, sun.target)

const hemi = new THREE.HemisphereLight('#bcd4ff', '#5b4a3a', 0.35)
scene.add(hemi)

const sunDir = new THREE.Vector3()
const _c1 = new THREE.Color()
const _c2 = new THREE.Color()

// Ключові кольори залежно від висоти сонця (градуси)
const FOG_KEYS = [[-14, '#060a14'], [-5, '#141a2c'], [0, '#c7826a'], [6, '#e8b48c'], [16, '#cfd0c8'], [32, '#b9cde0']]
const SUN_KEYS = [[-2, '#ff6a2a'], [4, '#ff9a55'], [12, '#ffd7a0'], [30, '#fff4e0']]
const sampleKeys = (keys, e, out) =>
{
    if(e <= keys[0][0]) return out.set(keys[0][1])
    for(let i = 0; i < keys.length - 1; i++)
    {
        const [e0, c0] = keys[i]
        const [e1, c1] = keys[i + 1]
        if(e <= e1) return out.set(c0).lerp(_c2.set(c1), THREE.MathUtils.smoothstep(e, e0, e1))
    }
    return out.set(keys[keys.length - 1][1])
}

let envDirty = true
let lastEnvTime = 0
const lightState = { night: 0, day: 1, elevation: 30 }

const updateTimeOfDay = (hour) =>
{
    const phase = ((hour - 6) / 24) * Math.PI * 2
    const elev = Math.sin(phase) * THREE.MathUtils.degToRad(63)
    const az = 1.0 + (hour - 12) * 0.15
    sunDir.set(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az))
    const e = THREE.MathUtils.radToDeg(elev)
    const day = THREE.MathUtils.smoothstep(e, -6, 10)
    const night = 1 - THREE.MathUtils.smoothstep(e, -14, -1)
    lightState.night = night
    lightState.day = day
    lightState.elevation = e

    for(const s of [sky, skyEnv]) s.material.uniforms.sunPosition.value.copy(sunDir)

    // сонце / місяць
    const useSun = e >= -2
    const dir = useSun ? sunDir : sunDir.clone().multiplyScalar(-1)
    sun.position.copy(sun.target.position).addScaledVector(dir, 200)
    if(useSun)
    {
        sampleKeys(SUN_KEYS, e, sun.color)
        sun.intensity = THREE.MathUtils.smoothstep(e, -2, 14) * 4.6
    }
    else
    {
        sun.color.set('#8aa2d8')
        sun.intensity = (1 - THREE.MathUtils.smoothstep(e, -14, -2)) * 3.0 * (0.4 + 0.6 * night)
    }

    // туман/горизонт, півсфера
    sampleKeys(FOG_KEYS, e, scene.fog.color)
    hemi.color.copy(scene.fog.color).lerp(_c2.set('#9fc0ff'), 0.4)
    hemi.color.lerp(_c2.set('#5870b0'), night)
    hemi.groundColor.set('#4d4034').lerp(_c2.set('#1a1e2a'), night).multiplyScalar(0.3 + 0.7 * Math.max(day, night * 0.6))
    hemi.intensity = 0.14 + 0.24 * day + 0.5 * night
    scene.environmentIntensity = 0.1 + 0.75 * day
    renderer.toneMappingExposure = params.exposure * (0.85 + 0.15 * day) * (1 + 0.25 * night)

    // хмари
    const cu = clouds.uniforms
    cu.uSunDir.value.copy(sunDir)
    cu.uLight.value.copy(sampleKeys([[-10, '#26304a'], [0, '#e8a47a'], [10, '#ffe2c4'], [30, '#ffffff']], e, new THREE.Color()))
    cu.uShade.value.copy(sampleKeys([[-10, '#0a0e1a'], [0, '#6a5460'], [10, '#a99aa0'], [30, '#8f9db0']], e, new THREE.Color()))
    cu.uCoverage.value = 0.62 - params.clouds * 0.3

    // зорі
    stars.material.opacity = THREE.MathUtils.clamp(night * 1.2 - 0.1, 0, 1)
    stars.visible = night > 0.02

    // вода рову
    if(terrain)
    {
        const wu = terrain.waterMaterial.uniforms
        wu.uSunDir.value.copy(sunDir)
        wu.uSunColor.value.copy(sun.color).multiplyScalar(useSun ? 1 : 0.15)
        wu.uSkyHorizon.value.copy(scene.fog.color)
        wu.uSkyTop.value.copy(sampleKeys([[-10, '#050914'], [0, '#6a7aa0'], [20, '#5d8fd0']], e, new THREE.Color()))
        wu.uDeep.value.copy(sampleKeys([[-10, '#03090d'], [10, '#235f69']], e, new THREE.Color()))
        clouds.uniforms.uFog.value.copy(scene.fog.color)
    }
    envDirty = true
}

const updateEnvironment = (now) =>
{
    if(!envDirty || now - lastEnvTime < 0.25) return
    envDirty = false
    lastEnvTime = now
    const target = pmrem.fromScene(envScene, 0, 0.1, 2000, { size: 256 })
    if(envTarget) envTarget.dispose()
    envTarget = target
    scene.environment = target.texture
}

/* =====================================================================
   3. Світ (збирається після завантаження ресурсів)
   ===================================================================== */
let terrain = null
let castle, camp, treb, vegetation, physics, birds, puffs
const soldiers = []     // { update(dt) }
const horses = []
const flameMats = []
const fireLights = []
const flagMeshes = []
let glassMats = []

const loaderFill = $('loader-fill')
const loaderStatus = $('loader-status')
const manager = new THREE.LoadingManager()
manager.onProgress = (url, loaded, total) => { loaderFill.style.width = `${Math.round((loaded / total) * 80)}%` }

const build = async () =>
{
    const M = createMaterials(manager, maxAniso)
    const models = await loadModels(manager)
    loaderStatus.textContent = 'Будуємо замок…'
    await new Promise((r) => setTimeout(r, 30))

    updateTimeOfDay(params.hour)

    // --- рельєф і вода ---
    terrain = createTerrain(M)
    scene.add(terrain.mesh, terrain.water)

    // --- замок ---
    castle = createCastle(M, timeU)
    scene.add(castle.group)

    // --- табір, требушет ---
    const wallCenter = new THREE.Vector3(-9, Y0 + 3.2, 44)
    treb = new Trebuchet(M, -36, 44, wallCenter)
    scene.add(treb.group)
    camp = createCamp(M, timeU, treb)
    scene.add(camp.group)

    // --- рослинність (не росте в таборі й на дорозі до мосту) ---
    vegetation = createVegetation(M, timeU, (x, z) => x < -22 && x > -64 && z > 18 && z < 70)
    scene.add(vegetation.group)

    // --- моделі glTF ---
    const addSoldier = (opts, pos, yaw, anim = 'Idle') =>
    {
        const s = new Soldier(models.soldier, opts)
        s.root.position.set(...pos)
        s.root.rotation.y = yaw
        s.play(anim)
        scene.add(s.root)
        soldiers.push(s)
        return s
    }
    for(const p of castle.patrols)
    {
        const s = new Soldier(models.soldier, { tint: '#ffb9a8' })
        scene.add(s.root)
        const a = [p.a[0], p.a[1] + Y0, p.a[2]]
        const b = [p.b[0], p.b[1] + Y0, p.b[2]]
        const patrol = new Patrol(s, a, b, p.speed)
        soldiers.push(patrol)
    }
    // вартові біля воріт зсередини
    addSoldier({ tint: '#ffb9a8' }, [-3.3, Y0, FOOT.hz - 6.5], 0.15)
    addSoldier({ tint: '#ffb9a8' }, [3.3, Y0, FOOT.hz - 6.5], -0.15)
    // навколо багаття
    const f = camp.fire
    addSoldier({ tint: '#9cb8ff' }, [f.x + 2.7, Y0, f.z + 0.6], -Math.PI / 2 - 0.2)
    addSoldier({ tint: '#9cb8ff' }, [f.x - 1.4, Y0, f.z + 2.3], Math.PI + 0.5)
    addSoldier({ tint: '#9cb8ff' }, [f.x - 2.3, Y0, f.z - 1.3], Math.PI / 2 + 0.3)
    // розрахунок требушета
    addSoldier({ tint: '#9cb8ff' }, [-39.5, Y0, 41.4], 0.4)
    addSoldier({ tint: '#9cb8ff' }, [-40.2, Y0, 46.8], 2.6)
    // марширують таборем / біжить кур'єр
    {
        const s = new Soldier(models.soldier, { tint: '#9cb8ff' })
        scene.add(s.root)
        soldiers.push(new Patrol(s, [-52, Y0, 29], [-42, Y0, 29], 1.2))
    }
    {
        const s = new Soldier(models.soldier, { tint: '#9cb8ff' })
        scene.add(s.root)
        const runner = new Patrol(s, [-30, Y0, 47], [8, Y0, 60], 3.4)
        runner.runner = true
        soldiers.push(runner)
    }

    const warHorse = new Horse(models.horse)
    scene.add(warHorse.root)
    horses.push(warHorse)
    const stableHorse = new Horse(models.horse, { stand: true })
    stableHorse.root.position.set(castle.stable.x - 0.8, Y0, castle.stable.z - 1.8)
    stableHorse.root.rotation.y = Math.PI * 0.95
    scene.add(stableHorse.root)
    horses.push(stableHorse)

    // --- ефекти ---
    birds = createBirds(timeU)
    scene.add(birds.mesh)
    puffs = new Puffs(scene, M.makePuff())
    puffs.addSources([...castle.smokeSources, ...camp.smokeSources])

    flameMats.push(...castle.flames, ...camp.flames)
    fireLights.push(...castle.lights, ...camp.lights)
    flagMeshes.push(...castle.flags)
    glassMats = M.windowGlass

    // --- фізика ---
    physics = new Physics()
    physics.addTerrain()
    physics.addStaticBoxes([...castle.colliders, ...camp.colliders, ...treb.colliders])
    scene.updateMatrixWorld(true)
    for(const p of castle.dynamicProps) physics.addProp(p, Y0)
    for(const p of camp.dynamicProps) physics.addProp(p, 0)
    physics.addBridge(castle.bridge)
    const projMat = M.rockMat.clone()
    projMat.color.setRGB(1.5, 1.45, 1.4)
    physics.createProjectiles(scene, projMat, 24)
    const brickMat = M.limestone.clone()
    brickMat.color.setRGB(5.0, 4.6, 4.1)
    scene.add(physics.addBrickWall(brickMat, { x: -9, z: 44, yaw: Math.PI / 2, cols: 9, rows: 12 }))
    scene.add(physics.addBrickWall(brickMat, { x: -5, z: 57, yaw: Math.PI / 2 - 0.35, cols: 5, rows: 8 }))
    physics.onImpact = (pos, strength) =>
    {
        puffs.burst(pos, strength)
        shake = Math.min(0.6, shake + strength * 0.012)
    }
    treb.onRelease = (P, target, theta) =>
    {
        const aim = target.clone().add(new THREE.Vector3(0, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 3.2))
        physics.fire(P, solveLaunch(P, aim, theta))
    }

    applyQuality(params.quality)
    applyTimeOfDay()
}

const applyTimeOfDay = () => updateTimeOfDay(params.hour)

/* =====================================================================
   4. Пост-обробка: MSAA → GTAO → Bloom → Tone mapping (Output) → Grade
   ===================================================================== */
let composer, renderPass, aoPass, bloomPass, outputPass, gradePass
const buildComposer = () =>
{
    const rt = new THREE.WebGLRenderTarget(sizes.width, sizes.height, { type: THREE.HalfFloatType, samples: 4 })
    composer = new EffectComposer(renderer, rt)
    composer.setPixelRatio(renderer.getPixelRatio())
    composer.setSize(sizes.width, sizes.height)

    renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)

    aoPass = new GTAOPass(scene, camera, sizes.width, sizes.height)
    aoPass.output = GTAOPass.OUTPUT.Default
    aoPass.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 16, distanceFallOff: 1, screenSpaceRadius: false })
    aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 16 })
    // GTAO малює «нормаль-прохід» усієї сцени; прозорі білборди полум'я, хмарна півсфера й спрайти дима йому не потрібні
    aoPass.overrideVisibility = function()
    {
        const cache = this._visibilityCache
        this.scene.traverse((o) =>
        {
            cache.set(o, o.visible)
            if(o.isPoints || o.isLine || o.isSprite || (o.userData && o.userData.noAO)) o.visible = false
        })
    }
    composer.addPass(aoPass)

    bloomPass = new UnrealBloomPass(new THREE.Vector2(sizes.width, sizes.height), params.bloom, 0.65, 1.0)
    composer.addPass(bloomPass)

    outputPass = new OutputPass()
    composer.addPass(outputPass)

    gradePass = new ShaderPass(GradeShader)
    composer.addPass(gradePass)
}

let currentQuality = null
function applyQuality(name)
{
    const q = QUALITY[name]
    if(!q) return
    currentQuality = name
    params.quality = name
    const dpr = Math.min(window.devicePixelRatio || 1, q.pr)
    renderer.setPixelRatio(dpr)
    renderer.setSize(sizes.width, sizes.height)
    if(!composer) buildComposer()
    composer.setPixelRatio(dpr)
    composer.setSize(sizes.width, sizes.height)
    for(const rt of [composer.renderTarget1, composer.renderTarget2])
    {
        if(rt.samples !== q.samples) { rt.samples = q.samples; rt.dispose() }
    }
    aoPass.enabled = q.ao
    bloomPass.enabled = q.bloom
    // розмір карти тіней
    if(sun.shadow.mapSize.x !== q.shadow)
    {
        sun.shadow.mapSize.set(q.shadow, q.shadow)
        if(sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null }
    }
    if(typeof qualityLabel !== 'undefined' && qualityLabel) qualityLabel.updateDisplay()
}

/* =====================================================================
   5. Камера: пресети, плавні переходи, «кіно», тряска
   ===================================================================== */
const VIEWS = {
    overview: { pos: [76, Y0 + 40, 100], target: [0, Y0 + 8, 0] },
    gate: { pos: [9, Y0 + 5, 52], target: [0, Y0 + 6, 22] },
    court: { pos: [12, Y0 + 8.5, 15], target: [-3, Y0 + 7, -9] },
    siege: { pos: [-60, Y0 + 11, 60], target: [-26, Y0 + 5, 40] }
}
let tween = null
let cinematic = false
let shake = 0
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

const flyTo = (name) =>
{
    const v = VIEWS[name]
    if(!v) return
    cinematic = false
    toolbarState()
    tween = {
        t: 0, dur: 2.4,
        p0: camera.position.clone(), p1: new THREE.Vector3(...v.pos),
        t0: controls.target.clone(), t1: new THREE.Vector3(...v.target)
    }
    controls.enabled = false
}

const jumpTo = (name) =>
{
    const v = VIEWS[name]
    camera.position.set(...v.pos)
    controls.target.set(...v.target)
    controls.update()
}

const updateCamera = (dt, t) =>
{
    if(tween)
    {
        tween.t += dt / tween.dur
        const k = ease(Math.min(tween.t, 1))
        camera.position.lerpVectors(tween.p0, tween.p1, k)
        controls.target.lerpVectors(tween.t0, tween.t1, k)
        if(tween.t >= 1) { tween = null; controls.enabled = true }
    }
    else if(cinematic)
    {
        const a = t * 0.07
        camera.position.set(Math.cos(a) * 82, Y0 + 24 + Math.sin(t * 0.11) * 9, Math.sin(a) * 92)
        controls.target.set(0, Y0 + 9, 0)
    }
    controls.update()
    // камера не йде під землю
    const gh = terrainHeight(camera.position.x, camera.position.z)
    if(camera.position.y < gh + 1.8) camera.position.y = gh + 1.8
    if(shake > 0.001)
    {
        camera.position.x += (Math.random() - 0.5) * shake
        camera.position.y += (Math.random() - 0.5) * shake
        shake *= Math.exp(-dt * 6)
    }
}

/* =====================================================================
   6. Дії: міст, решітка, требушет, гармата, скидання
   ===================================================================== */
const state = { bridge: 0, bridgeTarget: 0, gate: 0, gateTarget: 0 }  // 0 — опущений/опущена, 1 — піднятий/піднята
const toast = $('toast')
let toastTimer = 0
const say = (text) =>
{
    toast.textContent = text
    toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200)
}
const toolbarState = () =>
{
    document.querySelector('[data-action="cinematic"]').classList.toggle('on', cinematic)
    document.querySelector('[data-action="bridge"]').classList.toggle('on', state.bridgeTarget === 1)
    document.querySelector('[data-action="portcullis"]').classList.toggle('on', state.gateTarget === 1)
}
const actions = {
    bridge() { state.bridgeTarget = 1 - state.bridgeTarget; toolbarState(); say(state.bridgeTarget ? 'Міст піднімається' : 'Міст опускається') },
    portcullis() { state.gateTarget = 1 - state.gateTarget; toolbarState(); say(state.gateTarget ? 'Решітка піднімається' : 'Решітка опускається') },
    trebuchet() { say(treb.fire() ? 'Требушет, вогонь!' : 'Требушет ще заряджається…') },
    cannon()
    {
        const dir = new THREE.Vector3()
        camera.getWorldDirection(dir)
        physics.fire(camera.position.clone().addScaledVector(dir, 2.5), dir.multiplyScalar(58).add(new THREE.Vector3(0, 3, 0)))
    },
    reset() { physics.reset(); say('Сцену скинуто') },
    cinematic() { cinematic = !cinematic; tween = null; controls.enabled = !cinematic; toolbarState(); say(cinematic ? 'Кінорежим' : 'Вільна камера') }
}
document.getElementById('toolbar').addEventListener('click', (e) =>
{
    const b = e.target.closest('button')
    if(!b) return
    if(b.dataset.view) flyTo(b.dataset.view)
    else if(b.dataset.action && actions[b.dataset.action]) actions[b.dataset.action]()
})
window.addEventListener('keydown', (e) =>
{
    if(!physics || e.metaKey || e.ctrlKey) return
    const k = e.key.toLowerCase()
    if(k === '1') flyTo('overview')
    else if(k === '2') flyTo('gate')
    else if(k === '3') flyTo('court')
    else if(k === '4') flyTo('siege')
    else if(k === 'b') actions.bridge()
    else if(k === 'g') actions.portcullis()
    else if(k === 't') actions.trebuchet()
    else if(k === 'f') actions.cannon()
    else if(k === 'r') actions.reset()
    else if(k === 'c') actions.cinematic()
    else if(k === 'h') $('hud').classList.toggle('off')
})
canvas.addEventListener('pointerdown', () => { if(cinematic) { cinematic = false; controls.enabled = true; toolbarState() } })

/* =====================================================================
   7. lil-gui
   ===================================================================== */
let qualityLabel = null
const buildGui = () =>
{
    const gui = new GUI({ title: 'Налаштування', width: 280 })
    gui.close()
    const fTime = gui.addFolder('Час і погода')
    fTime.add(params, 'hour', 0, 24, 0.05).name('Година доби').onChange(applyTimeOfDay).listen()
    fTime.add(params, 'autoTime').name('Автозмінa часу')
    fTime.add(params, 'timeSpeed', 0.05, 3, 0.05).name('Швидкість (год/с)')
    fTime.add(params, 'clouds', 0, 1, 0.01).name('Хмарність').onChange(applyTimeOfDay)
    fTime.add(params, 'fog', 0, 0.01, 0.0001).name('Туман').onChange((v) => { scene.fog.density = v })
    fTime.add(params, 'wind', 0, 3, 0.05).name('Вітер').onChange((v) => { clouds.uniforms.uWind.value = v })

    const fRender = gui.addFolder('Рендер')
    qualityLabel = fRender.add(params, 'quality', Object.fromEntries(QUALITY_ORDER.map((k) => [QUALITY[k].name, k]))).name('Якість').onChange((v) => { params.adaptive = false; applyQuality(v) })
    fRender.add(params, 'exposure', 0.2, 1.6, 0.01).name('Експозиція').onChange(applyTimeOfDay)
    fRender.add(params, 'bloom', 0, 1.6, 0.01).name('Bloom').onChange((v) => { bloomPass.strength = v })
    fRender.add(params, 'ao', 0, 2, 0.01).name('AO (інтенсивність)').onChange((v) => { aoPass.blendIntensity = v })
    fRender.add(params, 'vignette', 0, 0.8, 0.01).name('Віньєтка').onChange((v) => { gradePass.uniforms.uVignette.value = v })
    fRender.add(params, 'grain', 0, 0.1, 0.001).name('Зерно').onChange((v) => { gradePass.uniforms.uGrain.value = v })
    fRender.add(params, 'contrast', 0.7, 1.5, 0.01).name('Контраст').onChange((v) => { gradePass.uniforms.uContrast.value = v })
    fRender.add(params, 'saturation', 0.4, 1.8, 0.01).name('Насиченість').onChange((v) => { gradePass.uniforms.uSaturation.value = v })
    fRender.add(params, 'shadows').name('Тіні').onChange((v) => { sun.castShadow = v })

    const fLight = gui.addFolder('Світло')
    fLight.add(params, 'torches', 0, 3, 0.05).name('Смолоскипи')
    fLight.add(sun, 'intensity').name('Сонце (поточне)').listen().disable()
    fLight.close()
    fTime.close(); fRender.close()
    return gui
}

/* =====================================================================
   8. Цикл анімації
   ===================================================================== */
const clock = new THREE.Clock()
let elapsed = 0
let frames = 0
let fpsAcc = 0
let fpsShown = 0
let slowTime = 0
let frameCount = 0
let started = false

const noise = (x) => Math.sin(x * 1.7) * 0.5 + Math.sin(x * 3.1 + 1.3) * 0.3 + Math.sin(x * 7.3) * 0.2

const tick = () =>
{
    const dt = Math.min(clock.getDelta(), 0.05)
    elapsed += dt
    timeU.value = elapsed
    frameCount++

    if(params.autoTime)
    {
        params.hour = (params.hour + dt * params.timeSpeed) % 24
        updateTimeOfDay(params.hour)
    }
    updateEnvironment(elapsed)

    // міст і решітка
    state.bridge += (state.bridgeTarget - state.bridge) * Math.min(1, dt * 1.6)
    state.gate += (state.gateTarget - state.gate) * Math.min(1, dt * 2.0)
    castle.setBridge(-1.32 * state.bridge)
    castle.portcullis.position.y = 6.3 * state.gate

    // вогонь: інтенсивність світла й полум'я залежить від часу доби
    const night = lightState.night
    const fireBoost = (0.35 + 0.65 * (night + (1 - lightState.day) * 0.5)) * params.torches
    for(const l of fireLights)
        l.intensity = l.userData.base * fireBoost * (0.8 + 0.28 * noise(elapsed * 6 + l.userData.phase))
    for(const m of flameMats) m.uniforms.uIntensity.value = 0.55 + 0.45 * Math.min(1, fireBoost)
    // вікна світяться ввечері
    const glow = THREE.MathUtils.lerp(0.0, 2.6, 1 - THREE.MathUtils.smoothstep(lightState.elevation, -4, 6)) * (0.92 + 0.08 * noise(elapsed * 3))
    for(const g of glassMats) g.emissiveIntensity = glow

    // тварини, люди, механізми
    for(const s of soldiers) s.update(dt)
    for(const h of horses) h.update(dt)
    treb.update(dt)
    birds.update(dt)
    birds.mesh.visible = lightState.day > 0.3
    puffs.update(dt, 0.4 * params.wind, night)
    physics.step(dt)

    clouds.uniforms.uTime.value = elapsed
    terrain.waterMaterial.uniforms.uTime.value = elapsed
    gradePass.uniforms.uTime.value = elapsed

    updateCamera(dt, elapsed)
    sky.position.copy(camera.position)
    clouds.mesh.position.copy(camera.position)
    stars.position.copy(camera.position)

    renderer.info.reset()
    composer.render(dt)

    // FPS, статистика, адаптивна якість
    frames++
    fpsAcc += dt
    if(fpsAcc >= 0.5)
    {
        fpsShown = Math.round(frames / fpsAcc)
        $('stats').textContent = `${fpsShown} fps · ${renderer.info.render.calls} draw · ${(renderer.info.render.triangles / 1000).toFixed(0)}k △ · ${physics.stats.awake}/${physics.stats.bodies} тіл`
        if(params.adaptive && started && elapsed > 4 && fpsShown < 24 && elapsed - slowTime > 2.5)
        {
            const i = QUALITY_ORDER.indexOf(currentQuality)
            if(i > 0)
            {
                applyQuality(QUALITY_ORDER[i - 1])
                say(`Якість автоматично знижено: ${QUALITY[currentQuality].name}`)
                slowTime = elapsed
            }
        }
        frames = 0
        fpsAcc = 0
    }
    requestAnimationFrame(tick)
}

/* =====================================================================
   9. Ресайз, старт
   ===================================================================== */
window.addEventListener('resize', () =>
{
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight
    camera.aspect = sizes.width / sizes.height
    camera.updateProjectionMatrix()
    renderer.setSize(sizes.width, sizes.height)
    composer.setSize(sizes.width, sizes.height)
})

build().then(() =>
{
    buildGui()
    gradePass.uniforms.uContrast.value = params.contrast
    gradePass.uniforms.uSaturation.value = params.saturation
    gradePass.uniforms.uVignette.value = params.vignette
    gradePass.uniforms.uGrain.value = params.grain
    aoPass.blendIntensity = params.ao
    loaderFill.style.width = '100%'
    loaderStatus.textContent = 'Готово'
    // кілька кадрів, щоб шейдери скомпілювались під лоадером
    tick()
    setTimeout(() =>
    {
        $('loader').classList.add('done')
        $('hud').classList.remove('hidden')
        started = true
        clock.getDelta()
    }, 700)
    // для налагодження/тестів
    window.__fortress = { horses, soldiers, jumpTo, VIEWS, scene, camera, controls, renderer, params, actions, flyTo, updateTimeOfDay, applyQuality, physics, treb, castle, state }
}).catch((err) =>
{
    console.error(err)
    loaderStatus.textContent = `Помилка: ${err.message}`
})
