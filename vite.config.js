export default {
    root: 'src/',
    publicDir: '../static/',
    base: './', // відносні шляхи — працює на Vercel, GitHub Pages, Netlify
    server: { host: true },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        sourcemap: false,
        chunkSizeWarningLimit: 1500
    }
}
