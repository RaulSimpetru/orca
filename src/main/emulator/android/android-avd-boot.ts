import { spawn } from 'node:child_process'
import { EmulatorError } from '../emulator-errors'
import { emulatorFailureText } from '../../../shared/emulator-failure-copy'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { bootCompletedArgs, isBootCompleted } from './adb-devices'
import { bootAvdArgs, listAvdsArgs, parseAvdList } from './avd-manager'
import {
  findRunningAvdSerial,
  listAdbEmulatorsInAnyState,
  listRunningAdbDevices
} from './android-device-inventory'
import { emulatorProbeError } from '../emulator-probe'

export type AndroidBootOptions = {
  bootTimeoutMs: number
  pollIntervalMs: number
  sleep: (ms: number) => Promise<void>
}

type AvdLaunch = {
  // Non-null once the emulator process has ended or failed to start.
  endReason: () => string | null
  outputTail: () => string
  closeOutput: () => void
}

const OUTPUT_TAIL_CHARS = 4096
const EXIT_DETAIL_LINES = 3

export async function bootAndroidDevice(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  deviceOrName: string,
  options: AndroidBootOptions
): Promise<string> {
  const running = await listRunningAdbDevices(runner, sdk)
  if (running.some((device) => device.serial === deviceOrName)) {
    return deviceOrName
  }
  const existing = await findRunningAvdSerial(runner, sdk, deviceOrName, running)
  if (existing) {
    return existing
  }
  // Reject stale serials before launching an invalid AVD and waiting out the boot timeout.
  const avds = parseAvdList((await runner(sdk.emulator, listAvdsArgs)).stdout)
  if (!avds.includes(deviceOrName)) {
    throw new EmulatorError(
      'emulator_device_not_found',
      emulatorFailureText('unknownDeviceOrAvd', { device: deviceOrName })
    )
  }
  const known = new Set(running.map((device) => device.serial))
  const launch = launchAvd(sdk.emulator, deviceOrName)
  try {
    return await waitForNewBootedSerial(runner, sdk, deviceOrName, known, launch, options)
  } finally {
    launch.closeOutput()
  }
}

// Unrefed hidden spawn: detached Windows emulators open consoles. Output is piped only for the
// boot wait; the emulator ignores SIGPIPE, so it keeps running after the pipes close.
function launchAvd(emulatorPath: string, avdName: string): AvdLaunch {
  const child = spawn(emulatorPath, [...bootAvdArgs(avdName), '-no-window'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  let endReason: string | null = null
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  // Handle spawn errors here so the boot poll reports failure instead of crashing main.
  child.on('error', (error) => {
    emulatorProbeError('emulator.launch.fail', error, { avdName })
    endReason ??= error.message
  })
  // A clean exit may be a launcher handing off to qemu, so only a failed exit ends the wait early.
  child.on('exit', (code, signal) => {
    if (signal || code !== 0) {
      endReason ??= signal ? `signal ${signal}` : `exit code ${code}`
    }
  })
  child.unref()
  return {
    endReason: () => endReason,
    outputTail: () => output,
    closeOutput: () => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
  }
}

async function waitForNewBootedSerial(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  avdName: string,
  known: Set<string>,
  launch: AvdLaunch,
  options: AndroidBootOptions
): Promise<string> {
  let waited = 0
  while (waited < options.bootTimeoutMs) {
    // Read before polling so an instance that appeared as our launch ended is still seen.
    const endReason = launch.endReason()
    const emulators = await listAdbEmulatorsInAnyState(runner, sdk)
    const fresh = (emulators ?? []).filter((device) => !known.has(device.serial))
    const serial = await findRunningAvdSerial(runner, sdk, avdName, fresh)
    if (serial) {
      const booted = await runner(sdk.adb, bootCompletedArgs(serial))
      if (isBootCompleted(booted.stdout)) {
        return serial
      }
    } else if (endReason !== null && emulators !== null) {
      // Our launch exits on the AVD lock when another instance is booting, so fail only when a
      // successful adb listing shows none.
      throw new EmulatorError(
        'emulator_helper_failed',
        emulatorFailureText('avdExitedBeforeBoot', {
          avdName,
          detail: emulatorExitDetail(launch.outputTail()) || endReason
        })
      )
    }
    await options.sleep(options.pollIntervalMs)
    waited += options.pollIntervalMs
  }
  throw new EmulatorError(
    'emulator_helper_failed',
    emulatorFailureText('avdBootTimeout', { avdName })
  )
}

// The emulator prints its reason last, e.g. a missing system image then "FATAL | Cannot find AVD system path".
function emulatorExitDetail(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-EXIT_DETAIL_LINES)
    .join('\n')
}
