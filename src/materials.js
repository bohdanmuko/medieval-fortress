import * as THREE from 'three'
import { makeRandom } from './world.js'

/**
 * Усі текстури й матеріали проєкту в одному місці.
 *  - PBR-набори (колір + ARM + нормаль) з папки static/textures
 *  - процедурні текстури, намальовані на canvas: дерево, прапори, дим
 */
export const createMaterials = (manager, maxAnisotropy = 8) =>
{
    const loader = new THREE.TextureLoader(manager)

    const load = (path, { srgb = false, repeat = [1, 1] } = {}) =>
    {
        const t = loader.load(`./textures/${path}`)
        if(srgb) t.colorSpace = THREE.SRGBColorSpace
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.repeat.set(repeat[0], repeat[1])
        t.anisotropy = maxAnisotropy
        return t
    }

    // колір + ARM (AO у R, roughness у G, metalness у B) + нормаль
    const pbr = (name) => ({
        color: load(`${name}_diff_1k.webp`, { srgb: true }),
        arm: load(`${name}_arm_1k.webp`),
        normal: load(`${name}_nor_gl_1k.webp`)
    })

    const tex = {
        brick: pbr('castle_brick_broken_06'),
        plaster: pbr('plastered_stone_wall'),
        roof: pbr('roof_slates_02'),
        rock: pbr('coast_sand_rocks_02'),
        leaves: pbr('leaves_forest_ground'),
        grass: load('grass_diff.webp', { srgb: true }),
        waterNormal: load('waternormals.webp'),
        door: {
            color: load('door/color.webp', { srgb: true }),
            alpha: load('door/alpha.webp'),
            ao: load('door/ambientOcclusion.webp'),
            height: load('door/height.webp'),
            normal: load('door/normal.webp'),
            metalness: load('door/metalness.webp'),
            roughness: load('door/roughness.webp')
        }
    }

    const makePBR = (set, color) =>
    {
        const m = new THREE.MeshStandardMaterial({
            map: set.color,
            aoMap: set.arm,
            roughnessMap: set.arm,
            metalnessMap: set.arm,
            normalMap: set.normal
        })
        if(color) m.color.set(color)
        return m
    }

    /**
     * Процедурне дерево (canvas): дошки, волокна, сучки. Друга текстура — bump з тих самих пікселів.
     */
    const rand = makeRandom(4242)
    const r = (a, b) => a + rand() * (b - a)
    const makeWood = () =>
    {
        const size = 512
        const cvs = document.createElement('canvas')
        cvs.width = cvs.height = size
        const c = cvs.getContext('2d')
        const planks = 4
        const w = size / planks
        for(let p = 0; p < planks; p++)
        {
            c.fillStyle = `hsl(${27 + r(-4, 4)}, ${28 + r(-6, 6)}%, ${34 + r(-5, 6)}%)`
            c.fillRect(p * w, 0, w, size)
            for(let i = 0; i < 80; i++)
            {
                const x = p * w + r(2, w - 2)
                c.strokeStyle = `rgba(${rand() > 0.5 ? '25,12,4' : '135,98,62'},${r(0.06, 0.24)})`
                c.lineWidth = r(0.5, 2.2)
                c.beginPath()
                c.moveTo(x, 0)
                c.bezierCurveTo(x + r(-5, 5), size * 0.33, x + r(-5, 5), size * 0.66, x + r(-4, 4), size)
                c.stroke()
            }
            if(rand() > 0.4)
            {
                c.fillStyle = 'rgba(30,14,5,0.55)'
                c.beginPath()
                c.ellipse(p * w + r(20, w - 20), r(40, size - 40), r(5, 9), r(8, 15), 0, 0, Math.PI * 2)
                c.fill()
            }
            c.fillStyle = 'rgba(10,5,2,0.85)'
            c.fillRect(p * w, 0, 3, size)
        }
        const color = new THREE.CanvasTexture(cvs)
        color.colorSpace = THREE.SRGBColorSpace
        color.wrapS = color.wrapT = THREE.RepeatWrapping
        color.anisotropy = maxAnisotropy
        const bump = new THREE.CanvasTexture(cvs)
        bump.wrapS = bump.wrapT = THREE.RepeatWrapping
        return { color, bump }
    }
    const wood = makeWood()

    // Геральдичні полотнища: дві гербові прапори (canvas)
    const makeBanner = (kind) =>
    {
        const w = 512
        const h = 320
        const cvs = document.createElement('canvas')
        cvs.width = w
        cvs.height = h
        const c = cvs.getContext('2d')
        if(kind === 0)
        {
            // червоне поле, золотий лев (спрощений: щит + хрест + кайма)
            c.fillStyle = '#9b1c1c'
            c.fillRect(0, 0, w, h)
            c.strokeStyle = '#e8c15a'
            c.lineWidth = 14
            c.strokeRect(14, 14, w - 28, h - 28)
            c.fillStyle = '#e8c15a'
            c.fillRect(w / 2 - 22, 50, 44, h - 100)
            c.fillRect(w / 2 - 100, h / 2 - 22, 200, 44)
            c.beginPath()
            c.arc(w / 2, h / 2, 46, 0, Math.PI * 2)
            c.fillStyle = '#9b1c1c'
            c.fill()
            c.lineWidth = 8
            c.strokeStyle = '#e8c15a'
            c.stroke()
        }
        else
        {
            // синьо-біле: діагональні смуги й зірки
            c.fillStyle = '#1e3a8a'
            c.fillRect(0, 0, w, h)
            c.fillStyle = '#f1f5f9'
            for(let i = -2; i < 6; i++)
            {
                c.save()
                c.translate(i * 110, 0)
                c.transform(1, 0, -0.55, 1, 0, 0)
                c.fillRect(0, 0, 36, h)
                c.restore()
            }
            c.fillStyle = '#facc15'
            for(let i = 0; i < 3; i++)
            {
                const cx = 150 + i * 105
                const cy = h / 2
                c.beginPath()
                for(let k = 0; k < 10; k++)
                {
                    const ang = (k / 10) * Math.PI * 2 - Math.PI / 2
                    const rad = k % 2 ? 14 : 34
                    c.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad)
                }
                c.closePath()
                c.fill()
            }
        }
        const t = new THREE.CanvasTexture(cvs)
        t.colorSpace = THREE.SRGBColorSpace
        t.anisotropy = maxAnisotropy
        return t
    }
    const banners = [makeBanner(0), makeBanner(1)]

    // м'яка пухнаста текстура (дим)
    const makePuff = () =>
    {
        const cvs = document.createElement('canvas')
        cvs.width = cvs.height = 128
        const c = cvs.getContext('2d')
        for(let i = 0; i < 10; i++)
        {
            const x = 64 + r(-22, 22)
            const y = 64 + r(-22, 22)
            const rad = r(20, 40)
            const g = c.createRadialGradient(x, y, 0, x, y, rad)
            g.addColorStop(0, 'rgba(255,255,255,0.35)')
            g.addColorStop(1, 'rgba(255,255,255,0)')
            c.fillStyle = g
            c.fillRect(0, 0, 128, 128)
        }
        const t = new THREE.CanvasTexture(cvs)
        t.colorSpace = THREE.SRGBColorSpace
        return t
    }

    /**
     * Матеріали
     */
    // Стіни: цегла (тоновано в сіро-кам'яний бік)
    const wall = makePBR(tex.brick, '#a39d96')
    // Вапняк веж: текстура штукатурки темна, тому множник кольору > 1 (лінійні значення)
    const limestone = makePBR(tex.plaster)
    limestone.color.setRGB(6.2, 5.9, 5.3)
    const darkStone = makePBR(tex.plaster)
    darkStone.color.setRGB(3.6, 3.5, 3.3)
    const roof = makePBR(tex.roof, '#8f9aa6')
    const roofRed = makePBR(tex.roof, '#a8503f') // червонувата черепиця для житлових будівель
    const rockMat = makePBR(tex.rock)
    rockMat.color.setRGB(2.0, 1.95, 1.9)
    const cobble = makePBR(tex.rock)
    cobble.color.setRGB(2.4, 2.35, 2.25)
    const foliage = makePBR(tex.leaves, '#3d6b34')
    foliage.side = THREE.DoubleSide

    const door = new THREE.MeshStandardMaterial({
        transparent: true,
        map: tex.door.color,
        alphaMap: tex.door.alpha,
        aoMap: tex.door.ao,
        displacementMap: tex.door.height,
        displacementScale: 0.15,
        displacementBias: -0.04,
        color: '#cdb9a5',
        normalMap: tex.door.normal,
        metalnessMap: tex.door.metalness,
        roughnessMap: tex.door.roughness
    })

    const woodMat = (color = '#ffffff') => new THREE.MeshStandardMaterial({
        map: wood.color, bumpMap: wood.bump, bumpScale: 2, roughness: 0.88, color
    })

    const iron = new THREE.MeshStandardMaterial({ color: '#2b2f33', metalness: 0.85, roughness: 0.45 })
    const bronze = new THREE.MeshStandardMaterial({ color: '#8c6a2b', metalness: 0.9, roughness: 0.35 })
    const darkIron = new THREE.MeshStandardMaterial({ color: '#17191b', metalness: 0.7, roughness: 0.6 })
    const frame = new THREE.MeshStandardMaterial({ color: '#2f2620', roughness: 0.8 })
    const rope = new THREE.MeshStandardMaterial({ color: '#b39b6d', roughness: 1 })
    const canvasCloth = new THREE.MeshStandardMaterial({ color: '#d9cdb0', roughness: 0.95, side: THREE.DoubleSide })
    const tentRed = new THREE.MeshStandardMaterial({ color: '#8c2f2a', roughness: 0.95, side: THREE.DoubleSide })
    const hay = new THREE.MeshStandardMaterial({ color: '#c8a84a', roughness: 1 })

    // Скло вікон: світиться вночі (інтенсивність задає time-of-day у main.js)
    const windowGlass = []
    const makeGlass = () =>
    {
        const m = new THREE.MeshStandardMaterial({ color: '#0b0f16', emissive: '#ffb347', emissiveIntensity: 0, roughness: 0.55, metalness: 0, envMapIntensity: 0.35 })
        windowGlass.push(m)
        return m
    }

    return {
        tex, wall, limestone, darkStone, roof, roofRed, rockMat, cobble, foliage, door,
        woodMat, wood, iron, bronze, darkIron, frame, rope, canvasCloth, tentRed, hay,
        banners, makePuff, makeGlass, windowGlass
    }
}
