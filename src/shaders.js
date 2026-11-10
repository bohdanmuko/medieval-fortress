import * as THREE from 'three'

/**
 * Усі власні шейдери проєкту (GLSL):
 *   1. createTerrainMaterial  — рельєф: трава / скеля / дорога / мул у рові залежно від нахилу й висоти (onBeforeCompile)
 *   2. patchFlagMaterial      — полотнище прапора: хвилі у вершинному шейдері + аналітична нормаль (onBeforeCompile)
 *   3. patchWindSway          — гойдання крон дерев на вітрі (onBeforeCompile, враховує InstancedMesh)
 *   4. createFlameMaterial    — вогонь смолоскипів / багаття: білборд + шум (ShaderMaterial, адитивне змішування)
 *   5. createWaterMaterial    — вода рову: дві рухомі нормал-мапи, Френель, відблиск сонця, туман (ShaderMaterial)
 *   6. createCloudDome        — хмари на небесній півсфері (fbm-шум, ShaderMaterial)
 *   7. GradeShader            — фінальна обробка кадру: віньєтка, зерно, контраст/насиченість (для ShaderPass)
 *
 * Матеріали MeshStandardMaterial розширюємо через onBeforeCompile: так зберігаються PBR-освітлення, тіні й туман Three.js.
 * Повністю власні ShaderMaterial (вогонь, вода, хмари) пишуться «з нуля».
 */

// Спільний GLSL-код шуму (використовують кілька шейдерів)
const NOISE_GLSL = /* glsl */`
float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float vnoise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p)
{
    float s = 0.0;
    float a = 0.5;
    for(int i = 0; i < 5; i++)
    {
        s += a * vnoise(p);
        p = p * 2.03 + 11.7;
        a *= 0.5;
    }
    return s;
}
`

/**
 * 1) РЕЛЬЄФ
 * Додаткові дані: атрибут aRoad (маска дороги, обчислена на CPU), світова позиція й нормаль.
 * Змішування: slope (1 - normal.y) → скеля; aRoad → ґрунт дороги; висота біля води → мул.
 */
export const createTerrainMaterial = (tex, waterY) =>
{
    const material = new THREE.MeshStandardMaterial({
        roughness: 0.96,
        metalness: 0,
        normalMap: tex.rock.normal,
        normalScale: new THREE.Vector2(0.55, 0.55)
    })
    const uniforms = {
        uGrass: { value: tex.grass },
        uRock: { value: tex.rock.color },
        uDirt: { value: tex.leaves.color },
        uWaterY: { value: waterY },
        uGrassTint: { value: new THREE.Color('#7f9b52') },
        uRockTint: { value: new THREE.Color('#bdb5a8') },
        uDirtTint: { value: new THREE.Color('#9a7d5c') }
    }
    material.userData.uniforms = uniforms
    material.onBeforeCompile = (shader) =>
    {
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', /* glsl */`#include <common>
attribute float aRoad;
varying float vRoad;
varying vec3 vWPos;
varying vec3 vWNormal;`)
            .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
vRoad = aRoad;
vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * normal);`)

        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', /* glsl */`#include <common>
uniform sampler2D uGrass;
uniform sampler2D uRock;
uniform sampler2D uDirt;
uniform float uWaterY;
uniform vec3 uGrassTint;
uniform vec3 uRockTint;
uniform vec3 uDirtTint;
varying float vRoad;
varying vec3 vWPos;
varying vec3 vWNormal;
${NOISE_GLSL}`)
            .replace('#include <map_fragment>', /* glsl */`
vec3 wn = normalize(vWNormal);
float slope = 1.0 - clamp(wn.y, 0.0, 1.0);
vec2 p = vWPos.xz;

// трава: два масштаби, щоб приховати повторення плитки
vec3 grass = mix(texture2D(uGrass, p / 8.0).rgb, texture2D(uGrass, p / 37.0 + 0.37).rgb, 0.5) * uGrassTint * 1.2;
// великі плями: соковита зелень ↔ суха, випалена трава
grass *= mix(vec3(0.82, 0.95, 0.72), vec3(1.22, 1.08, 0.78), fbm(p * 0.018 + 4.0));
// плями сухої трави / лісової підстилки
float patches = fbm(p * 0.05);
grass = mix(grass, texture2D(uDirt, p / 6.0).rgb * uDirtTint * 1.2, smoothstep(0.55, 0.8, patches) * 0.55);

// скеля: проєкція по трьох осях (на крутих схилах проєкція зверху розтягується)
vec3 tw = pow(abs(wn), vec3(4.0));
tw /= (tw.x + tw.y + tw.z);
vec3 rock = (texture2D(uRock, vWPos.zy / 7.0).rgb * tw.x
           + texture2D(uRock, p / 7.0).rgb * tw.y
           + texture2D(uRock, vWPos.xy / 7.0).rgb * tw.z) * uRockTint * 2.3;

vec3 dirt = texture2D(uDirt, p / 4.5).rgb * uDirtTint * 2.2;

float rockW = smoothstep(0.17, 0.34, slope + (fbm(p * 0.11) - 0.5) * 0.12);
float roadW = clamp(vRoad, 0.0, 1.0) * (1.0 - rockW);
vec3 col = mix(grass, rock, rockW);
col = mix(col, dirt, roadW);

// мул і волога земля на дні та берегах рову (тільки біля фортеці)
float nearCastle = 1.0 - smoothstep(52.0, 58.0, length(vWPos.xz));
float wet = (1.0 - smoothstep(uWaterY - 0.3, uWaterY + 0.9, vWPos.y)) * nearCastle;
col = mix(col, vec3(0.05, 0.045, 0.035), wet * 0.85);

diffuseColor.rgb *= col;`)
            .replace('#include <fog_fragment>', /* glsl */`#include <fog_fragment>
#ifdef USE_FOG
    // на краю карти рельєф повністю розчиняється в тумані (немає видимого «обрізу» світу)
    float edgeFade = smoothstep(240.0, 372.0, max(abs(vWPos.x), abs(vWPos.z)));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, edgeFade);
#endif`)
    }
    material.customProgramCacheKey = () => 'terrain-splat-v2'
    return material
}

/**
 * 2) ПРАПОР
 * Полотнище — PlaneGeometry(w, h, сегменти). Край біля древка (x = -w/2) нерухомий, далі амплітуда зростає.
 * Зміщення: z = A·k(x)·sin(kx·x − ω·t + ky·y). Нормаль обчислюємо аналітично (похідні), щоб світло «грало» на складках.
 */
export const patchFlagMaterial = (material, timeUniform, width = 4, amplitude = 0.35) =>
{
    material.onBeforeCompile = (shader) =>
    {
        shader.uniforms.uTime = timeUniform
        shader.uniforms.uWidth = { value: width }
        shader.uniforms.uAmp = { value: amplitude }
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', /* glsl */`#include <common>
uniform float uTime;
uniform float uWidth;
uniform float uAmp;
float flagWave(vec2 p, out vec2 grad)
{
    float k = clamp((p.x + uWidth * 0.5) / uWidth, 0.0, 1.0);   // 0 біля древка → 1 на вільному краї
    float arg = p.x * 2.2 - uTime * 4.2 + p.y * 1.1;
    float arg2 = p.x * 4.7 - uTime * 6.1 - p.y * 2.3;
    float w = (sin(arg) + 0.35 * sin(arg2)) * uAmp * k;
    grad.x = (cos(arg) * 2.2 + 0.35 * cos(arg2) * 4.7) * uAmp * k + (sin(arg) + 0.35 * sin(arg2)) * uAmp / uWidth;
    grad.y = (cos(arg) * 1.1 - 0.35 * cos(arg2) * 2.3) * uAmp * k;
    return w;
}`)
            .replace('#include <beginnormal_vertex>', /* glsl */`
vec2 fg;
float fz = flagWave(position.xy, fg);
vec3 objectNormal = normalize(vec3(-fg.x, -fg.y, 1.0));
#ifdef USE_TANGENT
    vec3 objectTangent = vec3(tangent.xyz);
#endif`)
            .replace('#include <begin_vertex>', /* glsl */`
vec3 transformed = vec3(position.x, position.y, position.z + fz);`)
    }
    material.customProgramCacheKey = () => 'flag-wave-v1'
    return material
}

/**
 * 3) ГОЙДАННЯ ДЕРЕВ
 * Зміщення пропорційне висоті вершини в локальних координатах дерева; фаза залежить від позиції інстанса.
 */
export const patchWindSway = (material, timeUniform, strength = 1) =>
{
    material.onBeforeCompile = (shader) =>
    {
        shader.uniforms.uTime = timeUniform
        shader.uniforms.uSway = { value: strength }
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', /* glsl */`#include <common>
uniform float uTime;
uniform float uSway;`)
            .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
#ifdef USE_INSTANCING
    vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
    vec3 ip = vec3(0.0);
#endif
float sh = max(transformed.y, 0.0);
float ph = uTime * 1.7 + ip.x * 0.071 + ip.z * 0.053;
transformed.x += sin(ph) * 0.03 * sh * uSway;
transformed.z += cos(ph * 0.83) * 0.024 * sh * uSway;`)
    }
    material.customProgramCacheKey = () => 'wind-sway-v1'
    return material
}

/**
 * 4) ВОГОНЬ
 * Білборд (завжди повернутий до камери): позиція квадрата обчислюється у view-просторі.
 * У фрагментному шейдері форма полум'я = звужувана краплина, «розхитана» fbm-шумом, що біжить вгору.
 * Колір > 1 (HDR), тому Bloom підсвічує вогонь.
 */
export const createFlameMaterial = (timeUniform, seed = 0, size = [0.55, 1.1], intensity = 1) =>
{
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uTime: timeUniform,
            uSeed: { value: seed },
            uSize: { value: new THREE.Vector2(size[0], size[1]) },
            uIntensity: { value: intensity }
        },
        vertexShader: /* glsl */`
            uniform vec2 uSize;
            varying vec2 vUv;
            void main()
            {
                vUv = uv;
                // центр білборда у view-просторі + зміщення вершини вздовж осей екрана
                vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                mv.xy += position.xy * uSize;
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            ${NOISE_GLSL}
            uniform float uTime;
            uniform float uSeed;
            uniform float uIntensity;
            varying vec2 vUv;
            void main()
            {
                vec2 p = vec2((vUv.x - 0.5) * 2.0, vUv.y);          // x ∈ [-1,1], y ∈ [0,1] знизу вгору
                float t = uTime * 1.9 + uSeed * 17.0;
                float n = fbm(vec2(p.x * 2.4 + uSeed, p.y * 2.6 - t * 1.5));
                float n2 = fbm(vec2(p.x * 5.0 - uSeed, p.y * 4.0 - t * 2.4));
                float taper = 1.0 - p.y;                             // ширина зменшується догори
                float shape = taper - abs(p.x) * (1.15 + p.y * 0.9) + (n - 0.5) * 0.75 * (0.25 + p.y) + (n2 - 0.5) * 0.25;
                float f = smoothstep(0.0, 0.42, shape);
                f *= 1.0 - smoothstep(0.55, 1.0, p.y + (n - 0.5) * 0.3);   // зникає на вершині
                vec3 hot = vec3(1.0, 0.86, 0.42);
                vec3 cold = vec3(1.0, 0.24, 0.03);
                vec3 col = mix(cold, hot, pow(f, 1.8)) * (1.4 + 2.2 * f) * uIntensity;
                gl_FragColor = vec4(col, f);
            }`
    })
}

/**
 * 5) ВОДА РОВУ
 * Нормаль = сума двох нормал-мап, що ковзають у різні боки. Колір = mix(глибина, небо, Френель) + відблиск сонця.
 * «Небо» для відбиття — простий градієнт (горизонт → зеніт), який main.js оновлює при зміні часу доби.
 */
export const createWaterMaterial = (normalMap) =>
{
    const uniforms = THREE.UniformsUtils.merge([
        THREE.UniformsLib['fog'],
        {
            uNormal: { value: normalMap },
            uTime: { value: 0 },
            uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.5).normalize() },
            uSunColor: { value: new THREE.Color('#fff2d6') },
            uSkyTop: { value: new THREE.Color('#5d8fd0') },
            uSkyHorizon: { value: new THREE.Color('#b9cfe6') },
            uDeep: { value: new THREE.Color('#0e2a28') },
            uRipple: { value: 0.55 }
        }
    ])
    const material = new THREE.ShaderMaterial({
        uniforms,
        fog: true,
        vertexShader: /* glsl */`
            #include <fog_pars_vertex>
            varying vec3 vWPos;
            void main()
            {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWPos = wp.xyz;
                vec4 mvPosition = viewMatrix * wp;
                gl_Position = projectionMatrix * mvPosition;
                #include <fog_vertex>
            }`,
        fragmentShader: /* glsl */`
            #include <fog_pars_fragment>
            uniform sampler2D uNormal;
            uniform float uTime;
            uniform vec3 uSunDir;
            uniform vec3 uSunColor;
            uniform vec3 uSkyTop;
            uniform vec3 uSkyHorizon;
            uniform vec3 uDeep;
            uniform float uRipple;
            varying vec3 vWPos;
            void main()
            {
                vec2 uv = vWPos.xz;
                vec3 n1 = texture2D(uNormal, uv * 0.11 + vec2(uTime * 0.020, uTime * 0.013)).rgb * 2.0 - 1.0;
                vec3 n2 = texture2D(uNormal, uv * 0.27 + vec2(-uTime * 0.017, uTime * 0.022)).rgb * 2.0 - 1.0;
                vec2 d = (n1.xy + n2.xy) * 0.5 * uRipple;
                vec3 N = normalize(vec3(d.x, 1.0, d.y));
                vec3 V = normalize(cameraPosition - vWPos);
                float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 4.5);
                vec3 R = reflect(-V, N);
                vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.7, R.y));
                float spec = pow(max(dot(R, uSunDir), 0.0), 260.0);
                vec3 col = mix(uDeep, sky, clamp(fres * 1.15, 0.0, 1.0)) + uSunColor * spec * 4.0;
                gl_FragColor = vec4(col, 1.0);
                #include <fog_fragment>
            }`
    })
    return material
}

/**
 * 6) ХМАРИ
 * Велика півсфера (BackSide). Напрямок зору проєктується на «шар хмар» (площина на висоті), звідти беремо fbm.
 * Освітлення «за ціною копійки»: порівнюємо щільність у точці та трохи зміщену в бік сонця.
 */
export const createCloudDome = () =>
{
    const uniforms = {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.3, 0.5, 0.6).normalize() },
        uCoverage: { value: 0.52 },
        uLight: { value: new THREE.Color('#ffffff') },
        uShade: { value: new THREE.Color('#8f9db0') },
        uOpacity: { value: 1 },
        uWind: { value: 1 },
        uFog: { value: new THREE.Color('#b9cde0') }
    }
    const material = new THREE.ShaderMaterial({
        uniforms,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        fog: false,
        vertexShader: /* glsl */`
            varying vec3 vDir;
            void main()
            {
                vDir = normalize(position);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.z = gl_Position.w; // завжди на дальній площині, як небо
            }`,
        fragmentShader: /* glsl */`
            ${NOISE_GLSL}
            uniform float uTime;
            uniform vec3 uSunDir;
            uniform float uCoverage;
            uniform vec3 uLight;
            uniform vec3 uShade;
            uniform float uOpacity;
            uniform float uWind;
            uniform vec3 uFog;
            varying vec3 vDir;
            float density(vec2 uv)
            {
                float base = fbm(uv);
                float detail = fbm(uv * 3.1 + 7.0);
                return smoothstep(uCoverage, uCoverage + 0.28, base * 0.78 + detail * 0.22);
            }
            void main()
            {
                vec3 dir = normalize(vDir);
                vec3 cloud = vec3(0.0);
                float aC = 0.0;
                if(dir.y > 0.0)
                {
                    // проєкція на площину хмар: чим ближче до горизонту, тим дрібніше й щільніше
                    vec2 uv = dir.xz / (dir.y + 0.12) * 0.55 + vec2(uTime * 0.012 * uWind, uTime * 0.006 * uWind);
                    float d = density(uv);
                    vec2 toSun = normalize(uSunDir.xz + 1e-4) * 0.05;
                    float dl = density(uv + toSun);
                    float lit = clamp(0.55 + (d - dl) * 3.0, 0.0, 1.0);          // скільки світла дійшло до цієї точки хмари
                    float sunGlow = pow(max(dot(dir, uSunDir), 0.0), 8.0);
                    cloud = mix(uShade, uLight, lit) + uLight * sunGlow * 0.35 * d;
                    aC = d * smoothstep(0.0, 0.16, dir.y) * uOpacity;
                }
                // серпанок біля горизонту (і під ним): колір = колір туману, тож небо плавно зливається з віддаленим рельєфом
                float haze = 0.85 * (1.0 - smoothstep(0.0, 0.2, dir.y)) + 0.15 * (1.0 - smoothstep(-0.04, 0.0, dir.y));
                float a = haze + (1.0 - haze) * aC;
                vec3 col = (uFog * haze + cloud * (1.0 - haze) * aC) / max(a, 1e-4);
                gl_FragColor = vec4(col, a);
            }`
    })
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), material)
    mesh.frustumCulled = false
    mesh.renderOrder = -1 // після неба, перед рештою прозорих
    return { mesh, uniforms }
}

/**
 * 7) ФІНАЛЬНА ОБРОБКА (після OutputPass, у sRGB): віньєтка, плівкове зерно, контраст і насиченість.
 */
export const GradeShader = {
    name: 'GradeShader',
    uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uVignette: { value: 0.32 },
        uGrain: { value: 0.025 },
        uContrast: { value: 1.06 },
        uSaturation: { value: 1.08 }
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main()
        {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uVignette;
        uniform float uGrain;
        uniform float uContrast;
        uniform float uSaturation;
        varying vec2 vUv;
        float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main()
        {
            vec3 c = texture2D(tDiffuse, vUv).rgb;
            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = mix(vec3(l), c, uSaturation);
            c = (c - 0.5) * uContrast + 0.5;
            vec2 q = vUv - 0.5;
            float v = 1.0 - smoothstep(0.2, 0.85, length(q * vec2(1.0, 0.85)));
            c *= mix(1.0 - uVignette, 1.0, v);
            c += (rnd(vUv * 1000.0 + fract(uTime)) - 0.5) * uGrain;      // дитеринг заодно прибирає бандинг неба
            gl_FragColor = vec4(c, 1.0);
        }`
}
