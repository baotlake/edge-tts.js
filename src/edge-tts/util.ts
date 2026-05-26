/**
 * Utility functions for the command line interface. Used by the main module.
 */

import { Command } from 'commander'
import * as fs from 'fs'
import * as process from 'process'
import Table from 'cli-table3'

import { Communicate } from './communicate'
import { SubMaker } from './submaker'
import { listVoices } from './voices'
import { DEFAULT_VOICE } from './constants'
import { UtilArgs } from './data_classes'
import { __version__ } from './version'
import { Voice } from './typing'

async function printVoices(proxy?: string): Promise<void> {
  /** Print all available voices. */
  let voices = await listVoices(proxy)
  voices = voices.sort((a: Voice, b: Voice) =>
    a.ShortName.localeCompare(b.ShortName),
  )

  const table = new Table({
    head: ['Name', 'Gender', 'ContentCategories', 'VoicePersonalities'],
    wordWrap: true,
  })

  for (const voice of voices) {
    table.push([
      voice.ShortName,
      voice.Gender,
      voice.VoiceTag.ContentCategories.join(', '),
      voice.VoiceTag.VoicePersonalities.join(', '),
    ])
  }

  console.log(table.toString())
}

async function runTts(args: UtilArgs): Promise<void> {
  /** Run TTS after parsing arguments from command line. */

  if (process.stdin.isTTY && process.stdout.isTTY && !args.writeMedia) {
    await new Promise<void>((resolve, reject) => {
      process.stderr.write(
        'Warning: TTS output will be written to the terminal. ' +
          'Use --write-media to write to a file.\n' +
          'Press Ctrl+C to cancel the operation. ' +
          'Press Enter to continue.\n',
      )
      process.stdin.once('data', () => resolve())
      process.once('SIGINT', () => {
        process.stderr.write('\nOperation canceled.\n')
        process.exit(0)
      })
    })
  }

  const communicate = new Communicate(args.text, args.voice, {
    rate: args.rate,
    volume: args.volume,
    pitch: args.pitch,
    proxy: args.proxy,
  })
  const submaker = new SubMaker()

  const audioFile =
    args.writeMedia && args.writeMedia !== '-'
      ? fs.createWriteStream(args.writeMedia)
      : process.stdout

  const subFile =
    args.writeSubtitles && args.writeSubtitles !== '-'
      ? fs.createWriteStream(args.writeSubtitles, { encoding: 'utf-8' })
      : args.writeSubtitles === '-'
      ? process.stderr
      : null

  try {
    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        audioFile.write(chunk.data)
      } else if (
        chunk.type === 'WordBoundary' ||
        chunk.type === 'SentenceBoundary'
      ) {
        submaker.feed(chunk)
      }
    }

    if (subFile) {
      subFile.write(submaker.getSrt())
    }
  } finally {
    if (audioFile !== process.stdout) {
      ;(audioFile as fs.WriteStream).end()
    }
    if (subFile && subFile !== process.stderr) {
      ;(subFile as fs.WriteStream).end()
    }
  }
}

export async function main(): Promise<void> {
  /** Async main function */
  const program = new Command()

  program
    .description("Text-to-speech using Microsoft Edge's online TTS service.")
    .option('-t, --text <text>', 'what TTS will say')
    .option('-f, --file <file>', 'same as --text but read from file')
    .option(
      '-v, --voice <voice>',
      `voice for TTS. Default: ${DEFAULT_VOICE}`,
      DEFAULT_VOICE,
    )
    .option('-l, --list-voices', 'lists available voices and exits')
    .option('--rate <rate>', 'set TTS rate. Default +0%.', '+0%')
    .option('--volume <volume>', 'set TTS volume. Default +0%.', '+0%')
    .option('--pitch <pitch>', 'set TTS pitch. Default +0Hz.', '+0Hz')
    .option(
      '--write-media <file>',
      'send media output to file instead of stdout',
    )
    .option('--write-subtitles <file>', 'send subtitle output to provided file')
    .option('--proxy <proxy>', 'use a proxy for TTS and voice list.')
    .version(`edge-tts ${__version__}`, '--version', 'output the version number')

  // Enforce mutual exclusivity for text, file, and list-voices
  program.on('option:text', () => {
    if (program.opts().file || program.opts().listVoices) {
      console.error(
        'Error: --text, --file, and --list-voices are mutually exclusive.',
      )
      process.exit(1)
    }
  })
  program.on('option:file', () => {
    if (program.opts().text || program.opts().listVoices) {
      console.error(
        'Error: --text, --file, and --list-voices are mutually exclusive.',
      )
      process.exit(1)
    }
  })
  program.on('option:list-voices', () => {
    if (program.opts().text || program.opts().file) {
      console.error(
        'Error: --text, --file, and --list-voices are mutually exclusive.',
      )
      process.exit(1)
    }
  })

  program.parse(process.argv)
  const args = program.opts<UtilArgs>()

  if (!(args.text || args.file || args.listVoices)) {
    console.error(
      "Error: required option '-t, --text <text>' or '-f, --file <file>' or '-l, --list-voices' not specified",
    )
    program.help()
  }

  if (args.listVoices) {
    await printVoices(args.proxy)
    process.exit(0)
  }

  if (args.file) {
    if (args.file === '-' || args.file === '/dev/stdin') {
      args.text = fs.readFileSync(0, 'utf-8') // Read from stdin
    } else {
      args.text = fs.readFileSync(args.file, 'utf-8')
    }
  }

  if (args.text) {
    await runTts(args)
  }
}

// Entry point for the CLI tool
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
