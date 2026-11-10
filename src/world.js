/**
 * Спільна «географія» світу: розміри, функція висоти рельєфу, шлях до брами.
 * Файл не залежить від Three.js — його використовують і рельєф (візуально), і фізика (heightfield),
 * тому м'ячі котяться рівно по тій поверхні, яку бачить глядач.
 *
 * Одиниця виміру: 1 = 1 метр. Вісь Y — вгору. Брама фортеці дивиться в бік +Z.
 */
export const Y0 = 28 // висота плато (де стоїть фортеця)
export const PLATEAU_R = 64 // радіус рівного плато
export const HILL_R = 150 // де закінчується схил пагорба
export const WATER_Y = Y0 - 1.3 // рівень води у рові
export const FOOT = { hx: 24, hz: 20 } // півширина/півглибина території всередині стін
export const MOAT = { inner: 5.9, outer: 13.5, depth: 3.4 } // відстань рову від стін, глибина

export const clamp = (v, a, b) => Math.min(Math.max(v, a), b)
export const lerp = (a, b, t) => a + (b - a) * t
export const smoothstep = (a, b, x) =>
{
    const t = clamp((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)
}

// Детермінований value-noise + fbm (ті самі значення в Node та в браузері)
const hash = (i, j) =>
{
    const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453
    return n - Math.floor(n)
}
const valueNoise = (x, y) =>
{
    const i = Math.floor(x)
    const j = Math.floor(y)
    const fx = x - i
    const fy = y - j
    const u = fx * fx * (3 - 2 * fx)
    const v = fy * fy * (3 - 2 * fy)
    return lerp(lerp(hash(i, j), hash(i + 1, j), u), lerp(hash(i, j + 1), hash(i + 1, j + 1), u), v)
}
export const fbm = (x, y, octaves = 4) =>
{
    let sum = 0
    let amp = 0.5
    let f = 1
    for(let o = 0; o < octaves; o++)
    {
        sum += (valueNoise(x * f, y * f) - 0.5) * 2 * amp
        amp *= 0.5
        f *= 2.03
    }
    return sum // приблизно [-1, 1]
}

// Відстань від точки до прямокутника зі стінами (від'ємна всередині)
export const sdBox = (x, z, hx = FOOT.hx, hz = FOOT.hz) =>
{
    const qx = Math.abs(x) - hx
    const qz = Math.abs(z) - hz
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0)
}

// Глибина рову на відстані d від стін: плавний рів між inner і outer
export const moatDepth = (d) =>
    MOAT.depth * smoothstep(MOAT.inner, MOAT.inner + 2, d) * (1 - smoothstep(MOAT.outer - 2, MOAT.outer, d))

export const terrainHeight = (x, z) =>
{
    const r = Math.hypot(x, z)

    // 1) Пагорб: рівне плато → плавний схил до нуля
    const t = clamp((r - PLATEAU_R) / (HILL_R - PLATEAU_R), 0, 1)
    let h = Y0 * (1 - smoothstep(0, 1, t))

    // 2) Шум на схилах (на плато шуму немає — воно рівне)
    const slopeWeight = smoothstep(PLATEAU_R - 6, PLATEAU_R + 24, r)
    h += (fbm(x * 0.012 + 7.3, z * 0.012 - 3.1, 4) * 11 + fbm(x * 0.06, z * 0.06, 3) * 1.8) * slopeWeight

    // 3) Далекі гори по краях карти
    const far = smoothstep(190, 340, r)
    h += far * (26 + 42 * (0.5 + 0.5 * fbm(x * 0.008 - 11, z * 0.008 + 5, 4)))

    // 4) Рів навколо стін
    h -= moatDepth(sdBox(x, z))
    return h
}

/**
 * Дорога на пагорб: ламана, що спіраллю піднімається до мосту (0, ROAD_END_Z).
 * Використовується шейдером рельєфу (маска «дороги») і розстановкою дерев (щоб не росли на дорозі).
 */
export const ROAD_END_Z = 35
export const roadPoints = (() =>
{
    const pts = []
    const n = 60
    for(let i = 0; i <= n; i++)
    {
        const t = i / n
        const r = lerp(185, ROAD_END_Z, Math.pow(t, 0.92))
        const a = lerp(1.15, 0, Math.pow(t, 0.85)) + Math.sin(t * 11) * 0.09 * (1 - t)
        pts.push([Math.sin(a) * r, Math.cos(a) * r])
    }
    return pts
})()

export const distToRoad = (x, z) =>
{
    let best = Infinity
    for(let i = 0; i < roadPoints.length - 1; i++)
    {
        const [ax, az] = roadPoints[i]
        const [bx, bz] = roadPoints[i + 1]
        const abx = bx - ax
        const abz = bz - az
        const t = clamp(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz), 0, 1)
        const d = Math.hypot(x - (ax + abx * t), z - (az + abz * t))
        if(d < best) best = d
    }
    return best
}

// Детермінований ГПВЧ для розстановок (дерева, каміння, тощо)
export const makeRandom = (seed = 1) =>
{
    let s = seed
    return () =>
    {
        s = (s * 16807) % 2147483647
        return (s - 1) / 2147483646
    }
}
