import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmulatorError } from '../emulator-errors'
import { emulatorFailureText } from '../../../shared/emulator-failure-copy'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { bootCompletedArgs, isBootCompleted } from './adb-devices'
import { bootAvdArgs, listAvdsArgs, parseAvdList } from './avd-manager'
import { findRunningAvdSerial, listRunningAdbDevices } from './android-device-inventory'
import { emulatorProbeError } from '../emulator-probe'

export type AndroidBootOptions = {
  bootTimeoutMs: number
  pollIntervalMs: number
  sleep: (ms: number) => Promise<void>
}

type AvdLaunch = {
  logPath: string
  // Non-null once the emulator process has ended or failed to start.
  endReason: () => string | null
}

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
  const logPath = join(tmpdir(), `orca-avd-launch-${randomUUID()}.log`)
  try {
    const launch = await launchAvd(sdk.emulator, deviceOrName, logPath)
    return await waitForNewBootedSerial(runner, sdk, deviceOrName, known, launch, options)
  } finally {
    await rm(logPath, { force: true }).catch(() => {})
  }
}

// Unrefed hidden spawn: detached Windows emulators open consoles. Output goes to a file, not a
// pipe, because the emulator outlives this wait and Orca, and a closed pipe could kill it.
async function launchAvd(
  emulatorPath: string,
  avdName: string,
  logPath: string
): Promise<AvdLaunch> {
  const log = await open(logPath, 'wx', 0o600)
  let endReason: string | null = null
  try {
    const child = spawn(emulatorPath, [...bootAvdArgs(avdName), '-no-window'], {
      stdio: ['ignore', log.fd, log.fd],
      windowsHide: true
    })
    // Handle spawn errors here so the boot poll reports failure instead of crashing main.
    child.on('error', (error) => {
      emulatorProbeError('emulator.launch.fail', error, { avdName })
      endReason ??= error.message
    })
    child.on('exit', (code, signal) => {
      endReason ??= signal ? `signal ${signal}` : `exit code ${code}`
    })
    child.unref()
  } finally {
    await log.close()
  }
  return { logPath, endReason: () => endReason }
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
    const endReason = launch.endReason()
    if (endReason !== null) {
      throw new EmulatorError(
        'emulator_helper_failed',
        emulatorFailureText('avdExitedBeforeBoot', {
          avdName,
          detail: (await readEmulatorExitDetail(launch.logPath)) || endReason
        })
      )
    }
    const fresh = (await listRunningAdbDevices(runner, sdk)).filter(
      (device) => device.isEmulator && !known.has(device.serial)
    )
    const serial = await findRunningAvdSerial(runner, sdk, avdName, fresh)
    if (serial) {
      const booted = await runner(sdk.adb, bootCompletedArgs(serial))
      if (isBootCompleted(booted.stdout)) {
        return serial
      }
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
async function readEmulatorExitDetail(logPath: string): Promise<string> {
  const output = await readFile(logPath, 'utf8').catch(() => '')
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-EXIT_DETAIL_LINES)
    .join('\n')
}
