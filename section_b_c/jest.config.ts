import type { Config } from 'jest'
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  coverageThreshold: {
    global: { lines: 90, branches: 85 }
  }
}
export default config
