import * as THREE from 'three'
import { Physics } from './src/physics.js'
import { solveLaunch } from './src/camp.js'
const ph = new Physics()
ph.addTerrain()
const mat = new THREE.MeshBasicMaterial()
ph.addBrickWall(mat, { x: -9, z: 44, yaw: Math.PI / 2, cols: 9, rows: 12 })
const scene = new THREE.Scene()
ph.createProjectiles(scene, mat, 4)
const w = ph.walls[0]
const start = w.bodies.map(b => b.position.clone())
const P = new THREE.Vector3(-31.5, 48.8, 44.2)
const v = solveLaunch(P, new THREE.Vector3(-9, 31.2, 44.3), 0.85)
console.log('v', v)
ph.fire(P, v)
let hits = 0
ph.projectiles[0].body.addEventListener('collide', (e) => { hits++; if (hits < 6) console.log('collide with body id', e.body.id, 'mass', e.body.mass, e.body.position.x.toFixed(1), e.body.position.y.toFixed(1)) })
for (let i = 0; i < 60 * 8; i++) {
  ph.step(1 / 60)
  if (i % 20 === 0) { const b = ph.projectiles[0].body; console.log(i, b.position.x.toFixed(1), b.position.y.toFixed(1), b.position.z.toFixed(1)) }
}
let moved = 0; w.bodies.forEach((b, i) => { if (b.position.distanceTo(start[i]) > 0.3) moved++ })
console.log('moved', moved, '/', w.bodies.length)
