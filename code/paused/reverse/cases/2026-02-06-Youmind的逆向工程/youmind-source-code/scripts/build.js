/* eslint-disable no-undef */
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import packageJson from '../package.json' with { type: 'json' }
const { version } = packageJson

const env = process.env.ENV

const now = new Date()
  .toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  .replace(/\/|,|:| /g, '-')

const outputFilename = `youext_${version}_${env}_${now}.zip`

process.env.VITE_OUTPUT_FILENAME = outputFilename

// 新增代码: 将 outputFilename 写入临时文件
const buildDir = path.join(process.cwd(), '.build')
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir)
}
fs.writeFileSync(path.join(buildDir, 'outputFilename'), outputFilename)

execSync('vite build', { stdio: 'inherit' })

// 新增代码: 输出压缩包名称和大小
const distDir = path.join(process.cwd(), 'artifacts')
const zipPath = path.join(distDir, outputFilename)

if (fs.existsSync(zipPath)) {
  const stats = fs.statSync(zipPath)
  const fileSizeInBytes = stats.size
  const fileSizeInMegabytes = fileSizeInBytes / (1024 * 1024)

  console.log(`build success:`)
  console.log(`file name: ${outputFilename}`)
  console.log(`file size: ${fileSizeInMegabytes.toFixed(2)} MB`)
} else {
  console.log(`build failed:`)
  console.log(`file name: ${outputFilename}`)
}
