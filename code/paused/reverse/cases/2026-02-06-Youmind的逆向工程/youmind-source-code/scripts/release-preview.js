import { execSync } from 'child_process'

execSync('npm run build:preview', { stdio: 'inherit' })

execSync('node scripts/release.js', { stdio: 'inherit' })
