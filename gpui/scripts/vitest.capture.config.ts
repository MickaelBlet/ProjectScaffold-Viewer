import { mergeConfig } from 'vitest/config'
import base from '../../vitest.config'

export default mergeConfig(base, { test: { setupFiles: ['gpui/scripts/capture-validate.ts'] } })
