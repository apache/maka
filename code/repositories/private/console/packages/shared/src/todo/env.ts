import { z } from 'zod'

/** 服务端环境变量（Q17 定案；启动时校验，contracts 包复用第三次） */
export const EnvSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  PORT: z.coerce.number().int().default(3000),
})
export type Env = z.infer<typeof EnvSchema>
