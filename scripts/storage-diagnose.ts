import { pathToFileURL } from 'node:url'
import { diagnoseStorage } from './storage-diagnostics.ts'

/** Explicit path only: never discover a Desktop profile or construct a Host store. */
export function storageDiagnoseMain(args: string[]): number {
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('用法：npm run storage:diagnose -- /absolute/storage/directory\n')
    return 2
  }
  const report = diagnoseStorage(args[0])
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  return report.complete ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = storageDiagnoseMain(process.argv.slice(2))
}
