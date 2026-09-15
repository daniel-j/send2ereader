#!/usr/bin/env node

const http = require('http')
const Koa = require('koa')
const Router = require('@koa/router')
const multer = require('@koa/multer')
const logger = require('koa-logger')
const sendfile = require('koa-sendfile')
const serve = require('koa-static')
const { mkdirp } = require('mkdirp')
const fs = require('fs')
const { spawn } = require('child_process')
const { join, extname, basename, dirname } = require('path')
const resolvepath = require('path').resolve
const FileType = require('file-type')
const { transliterate } = require('transliteration')
const sanitize = require('sanitize-filename')

const port = 3001
const expireDelay = 30  // 30 seconds
const maxExpireDuration = 1 * 60 * 60  // 1 hour
const maxFileSize = 1024 * 1024 * 500  // 500 MB per individual file
const maxBatchBytes = 1024 * 1024 * 500  // 500 MB total per upload request
const maxKeyBytes = 1024 * 1024 * 500  // 500 MB accumulated per key (files append)
const maxFilesPerBatch = 20  // per upload request
const maxFilesPerKey = 20  // accumulated per key
const multipartOverhead = 1024 * 1024  // slack for multipart boundaries and text fields
const requestTimeout = 30 * 60 * 1000  // 30 minutes to receive a whole upload

const TYPE_EPUB = 'application/epub+zip'
const TYPE_MOBI = 'application/x-mobipocket-ebook'

const allowedTypes = [TYPE_EPUB, TYPE_MOBI, 'application/pdf', 'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar', 'text/html', 'text/plain', 'application/zip', 'application/x-rar-compressed']
const allowedExtensions = ['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'html', 'txt']

const keyChars = "23456789ACDEFGHJKLMNPRSTUVWXYZ"
const keyLength = 4


function doTransliterate(filename) {
  let name = filename.split(".")
  const ext = "." + name.splice(-1).join(".")
  name = name.join(".")

  return transliterate(name) + ext
}

function randomKey () {
  const choices = Math.pow(keyChars.length, keyLength)
  const rnd = Math.floor(Math.random() * choices)

  return rnd.toString(keyChars.length).padStart(keyLength, '0').split('').map((chr) => {
    return keyChars[parseInt(chr, keyChars.length)]
  }).join('')
}

function unlinkQuiet (path) {
  if (!path) return
  fs.unlink(path, (err) => {
    if (err && err.code !== 'ENOENT') console.error(err)
    else if (!err) console.log('Removed file', path)
  })
}

function formatMB (bytes) {
  return Math.round(bytes / (1024 * 1024)) + ' MB'
}

function escapeHtml (str) {
  return String(str).replace(/[&<>"]/g, (chr) => {
    return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[chr]
  })
}

// Splits a filename into [base, extension], keeping the .kepub.epub double
// extension together so dedupe produces book_2.kepub.epub, not book.kepub_2.epub
function splitName (name) {
  const match = /\.kepub\.epub$/i.exec(name)
  if (match) return [name.slice(0, match.index), name.slice(match.index)]
  const ext = extname(name)
  return [name.slice(0, name.length - ext.length), ext]
}

// downloadFile matches purely by name, so two files sharing one would leave the
// second permanently unreachable. Underscore rather than " (2)" because the
// Kindle filename sanitizer below strips spaces but keeps parentheses.
function uniqueName (info, desired) {
  if (!info.files.some((file) => file.name === desired)) return desired
  const [base, ext] = splitName(desired)
  for (let n = 2; n < 100; n++) {
    const candidate = base + '_' + n + ext
    if (!info.files.some((file) => file.name === candidate)) return candidate
  }
  return base + '_' + Math.floor(Math.random() * 1E6) + ext
}

function removeKey (key) {
  const info = app.context.keys.get(key)
  if (!info) {
    console.log('Tried to remove non-existing key', key)
    return
  }
  if (info.busy > 0) {
    // An upload is mid-batch: don't unlink files out from under it. It will call
    // removeKey again once it's done.
    console.log('Key', key, 'is busy, postponing removal')
    info.pendingRemoval = true
    clearTimeout(info.timer)
    info.timer = setTimeout(removeKey, 5 * 1000, key)
    return
  }
  console.log('Removing expired key', key)
  clearTimeout(info.timer)
  for (const file of info.files) {
    console.log('Deleting file', file.path)
    unlinkQuiet(file.path)
  }
  info.files = []
  info.bytes = 0
  app.context.keys.delete(key)
}

function expireKey (key) {
  // console.log('key', key, 'will expire in', expireDelay, 'seconds')
  const info = app.context.keys.get(key)
  if (!info) return null
  clearTimeout(info.timer)
  info.timer = setTimeout(removeKey, expireDelay * 1000, key)
  info.alive = new Date()
  return info.timer
}

function flash (ctx, data) {
  console.log(data)
  //ctx.cookies.set('flash', encodeURIComponent(JSON.stringify(data)), {overwrite: true, httpOnly: false, sameSite: 'strict', maxAge: 10 * 1000})
  ctx.response.status = data.status || (data.success ? 200 : 400)
  if (!data.success) {
    ctx.set("Connection", "close")
  }
  ctx.body = data.message
}

const app = new Koa()
app.context.keys = new Map()
app.use(logger())

const router = new Router()

const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, 'uploads')
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.floor(Math.random() * 1E9)
      cb(null, file.fieldname + '-' + uniqueSuffix + extname(file.originalname).toLowerCase())
    }
  }),
  limits: {
    fileSize: maxFileSize,
    files: maxFilesPerBatch
  },
  fileFilter: (req, file, cb) => {
    // Fixes charset
    // https://github.com/expressjs/multer/issues/1104#issuecomment-1152987772
    file.originalname = sanitize(Buffer.from(file.originalname, 'latin1').toString('utf8'))

    console.log('Incoming file:', file)
    // req.body is only populated from parts already parsed, so this relies on the
    // key field coming before the file fields in the form.
    const key = String(req.body.key || '').toUpperCase()
    if (!app.context.keys.has(key)) {
      console.error('FileFilter: Unknown key: ' + key)
      cb("Unknown key " + key, false)
      return
    }
    if ((!allowedTypes.includes(file.mimetype) && file.mimetype != "application/octet-stream") || !allowedExtensions.includes(extname(file.originalname.toLowerCase()).substring(1))) {
      console.error('FileFilter: File is of an invalid type ', file)
      cb("Invalid filetype: " + JSON.stringify(file), false)
      return
    }
    cb(null, true)
  }
})

// On the rejection path @koa/multer never copies the files onto ctx.request, so
// check both locations before giving up on cleaning the temp files.
function cleanupRequestFiles (ctx) {
  const files = ctx.request.files || ctx.req.files || []
  for (const file of files) {
    unlinkQuiet(file.path)
  }
  const single = ctx.request.file || ctx.req.file
  if (single) unlinkQuiet(single.path)
}

function multerError (err) {
  switch (err && err.code) {
    case 'LIMIT_FILE_SIZE':
      return {success: false, status: 413, message: 'A file exceeds the ' + formatMB(maxFileSize) + ' per-file limit.'}
    case 'LIMIT_FILE_COUNT':
      return {success: false, status: 413, message: 'Too many files — maximum ' + maxFilesPerBatch + ' per upload.'}
    case 'LIMIT_UNEXPECTED_FILE':
      return {success: false, message: 'Unexpected file field: ' + err.field}
    default:
      // Errors raised by fileFilter arrive as plain strings. Never pass an Error
      // object through: Koa JSON-serializes it and the client receives "{}".
      return {success: false, message: err && err.message ? err.message : String(err)}
  }
}

router.post('/generate', async ctx => {
  const agent = ctx.get('user-agent')

  let key = null
  let attempts = 0
  console.log('There are currently', ctx.keys.size, 'key(s) in use.')
  console.log('Generating unique key...', ctx.ip, agent)
  do {
    key = randomKey()
    if (attempts > ctx.keys.size) {
      console.error('Can\'t generate more keys, map is full.', attempts, ctx.keys.size)
      ctx.body = 'error'
      return
    }
    attempts++
  } while (ctx.keys.has(key))

  console.log('Generated key ' + key + ', '+attempts+' attempt(s)')

  const info = {
    created: new Date(),
    agent: agent,
    files: [],       // [{name, path, size, conversion, uploaded}]
    bytes: 0,        // total size on disk of the stored (post-conversion) files
    busy: 0,         // number of /upload handlers currently writing to this key
    pendingRemoval: false,
    lock: Promise.resolve(),  // serializes uploads to this key
    urls: []
  }
  ctx.keys.set(key, info)
  expireKey(key)
  setTimeout(() => {
    // remove if it is the same object
    if(ctx.keys.get(key) === info) removeKey(key)
  }, maxExpireDuration * 1000)

  ctx.cookies.set('key', key, {overwrite: true, httpOnly: false, sameSite: 'strict', maxAge: expireDelay * 1000})

  ctx.body = key
})

/*
router.get('/download/:key', async ctx => {
  const key = ctx.cookies.get('key')
  if (!key) {
    await next()
    return
  }

  const info = ctx.keys.get(key)

  if (!info || info.files.length === 0) {
    await next()
    return
  }

  ctx.redirect('/' + encodeURIComponent(info.files[0].name));
})
*/

async function downloadFile (ctx, next) {
  const key = ctx.query.key
  if (!key) {
    await next()
    return
  }

  // @koa/router already decodes ctx.params, decoding again throws URIError on
  // any name containing a literal % (which sanitize-filename permits).
  const filename = ctx.params.filename
  const info = ctx.keys.get(key)

  if (!info) {
    await next()
    return
  }

  const file = info.files.find((entry) => entry.name === filename)

  if (!file) {
    await next()
    return
  }
  if (info.agent !== ctx.get('user-agent')) {
    console.error("User Agent doesnt match: " + info.agent + " VS " + ctx.get('user-agent'))
    return
  }
  expireKey(key)
  console.log('Sending file', [file.path, file.name])
  if (info.agent.includes('Kindle')) {
    // Kindle needs a safe name or it thinks it's an invalid file
    ctx.attachment(file.name)
  }
  await sendfile(ctx, file.path)
}

/**
 * Validates and converts a single uploaded file. Consumes file.path: on every
 * return path the temporary input is either unlinked or is the returned path.
 *
 * @param {object} file one multer file ({path, originalname, mimetype, size})
 * @param {object} info the key info object (agent decides the conversion)
 * @param {object} body the parsed form fields (conversion checkboxes)
 * @returns {Promise<{ok: true, originalName: string, name: string, path: string, size: number, conversion: string|null}
 *                 | {ok: false, originalName: string, error: string}>}
 */
async function processUploadedFile (file, info, body) {
  try {
    if (file.size === 0) {
      unlinkQuiet(file.path)
      return {ok: false, originalName: file.originalname, error: 'Invalid file submitted (empty file)'}
    }

    let mimetype = file.mimetype

    const type = await FileType.fromFile(file.path)

    if (mimetype == "application/octet-stream" && type) {
      mimetype = type.mime
    }

    if (mimetype == "application/epub") {
      mimetype = TYPE_EPUB
    }

    if ((!type || !allowedTypes.includes(type.mime)) && !allowedTypes.includes(mimetype)) {
      unlinkQuiet(file.path)
      return {
        ok: false,
        originalName: file.originalname,
        error: 'Uploaded file is of an invalid type (' + (type ? type.mime : 'unknown mimetype') + ')'
      }
    }

    let data = null
    let conversion = null
    let filename = file.originalname
    if (body.transliteration) {
      filename = sanitize(doTransliterate(filename))
    }
    if (info.agent.includes('Kindle')) {
      filename = filename.replace(/[^\.\w\-"'\(\)]/g, '_')
    }

    if (mimetype === TYPE_EPUB && info.agent.includes('Kindle') && body.kindlegen) {
      // convert to .mobi
      conversion = 'kindlegen'
      const outname = file.path.replace(/\.epub$/i, '.mobi')
      const mobi8name = file.path.replace(/\.epub$/i, '.mobi8')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi')
      let stderr = ''

      let p = new Promise((resolve, reject) => {
        const kindlegen = spawn('kindlegen', [basename(file.path), '-dont_append_source', '-c1', '-o', basename(outname)], {
          // stdio: 'inherit',
          cwd: dirname(file.path)
        })
        kindlegen.once('error', function (err) {
          unlinkQuiet(file.path)
          unlinkQuiet(mobi8name)
          unlinkQuiet(outname)
          reject('kindlegen error: ' + err)
        })
        kindlegen.once('close', (code) => {
          unlinkQuiet(file.path)
          unlinkQuiet(mobi8name)
          if (code !== 0 && code !== 1) {
            unlinkQuiet(outname)
            reject('kindlegen error code: ' + code + '\n' + stderr)
            return
          }

          resolve(outname)
        })
        kindlegen.stdout.on('data', function (str) {
          stderr += str
          console.log('kindlegen: ' + str)
        })
        kindlegen.stderr.on('data', function (str) {
          stderr += str
          console.log('kindlegen: ' + str)
        })
      })
      try {
        data = await p
      } catch (err) {
        return {
          ok: false,
          originalName: file.originalname,
          error: String(err).replaceAll(basename(file.path), "infile.epub").replaceAll(basename(outname), "outfile.mobi")
        }
      }

    } else if (mimetype === TYPE_EPUB && info.agent.includes('Kobo') && body.kepubify) {
      // convert to Kobo EPUB
      conversion = 'kepubify'
      const outname = file.path.replace(/\.epub$/i, '.kepub.epub')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub')

      let p = new Promise((resolve, reject) => {
        let stderr = ''
        const kepubify = spawn('kepubify', ['-v', '-u', '-o', basename(outname), basename(file.path)], {
          //stdio: 'inherit',
          cwd: dirname(file.path)
        })
        kepubify.once('error', function (err) {
          unlinkQuiet(file.path)
          unlinkQuiet(outname)
          reject('kepubify error: ' + err)
        })
        kepubify.once('close', (code) => {
          unlinkQuiet(file.path)
          if (code !== 0) {
            unlinkQuiet(outname)
            reject('Kepubify error code: ' + code + '\n' + stderr)
            return
          }

          resolve(outname)
        })
        kepubify.stdout.on('data', function (str) {
          stderr += str
          console.log('kepubify: ' + str)
        })
        kepubify.stderr.on('data', function (str) {
          stderr += str
          console.log('kepubify: ' + str)
        })
      })
      try {
        data = await p
      } catch (err) {
        return {
          ok: false,
          originalName: file.originalname,
          error: String(err).replaceAll(basename(file.path), "infile.epub").replaceAll(basename(outname), "outfile.kepub.epub")
        }
      }

    } else if (mimetype == 'application/pdf' && body.pdfcropmargins) {
      conversion = 'pdfcropmargins'
      const dir = dirname(file.path)
      const base = basename(file.path, '.pdf')
      const outfile = resolvepath(join(dir, `${base}_cropped.pdf`))
      let p = new Promise((resolve, reject) => {
        let stderr = ''
        const pdfcropmargins = spawn('pdfcropmargins', ['-s', '-u', '-o', outfile, basename(file.path)], {
          // stdio: 'inherit',
          cwd: dirname(file.path)
        })
        pdfcropmargins.once('error', function (err) {
          unlinkQuiet(file.path)
          unlinkQuiet(outfile)
          reject('pdfcropmargins error: ' + err)
        })
        pdfcropmargins.once('close', (code) => {
          unlinkQuiet(file.path)
          if (code !== 0) {
            unlinkQuiet(outfile)
            reject('pdfcropmargins error code: ' + code + '\n' + stderr)
            return
          }

          resolve(outfile)
        })
        pdfcropmargins.stdout.on('data', function (str) {
          stderr += str
          console.log('pdfcropmargins: ' + str)
        })
        pdfcropmargins.stderr.on('data', function (str) {
          stderr += str
          console.log('pdfcropmargins: ' + str)
        })
      })
      try {
        data = await p
      } catch (err) {
        return {
          ok: false,
          originalName: file.originalname,
          error: String(err).replaceAll(basename(file.path), "infile.pdf").replaceAll(outfile, "outfile.pdf")
        }
      }

    } else {
      // No conversion
      data = file.path
    }

    let size = 0
    try {
      size = (await fs.promises.stat(data)).size
    } catch (err) {
      unlinkQuiet(data)
      return {ok: false, originalName: file.originalname, error: 'Conversion produced no output file'}
    }

    return {ok: true, originalName: file.originalname, name: filename, path: data, size: size, conversion: conversion}

  } catch (err) {
    // Degrade one file rather than throwing out of the batch and orphaning the rest
    console.error(err)
    unlinkQuiet(file.path)
    return {
      ok: false,
      originalName: file.originalname,
      error: 'Unexpected error: ' + (err && err.message ? err.message : String(err))
    }
  }
}

/**
 * Converts and stores a batch of files under one key. Runs under the key's lock
 * so the storage caps and the dedupe check are read-modify-write safe.
 *
 * Conversions run one at a time on purpose: kindlegen, kepubify and
 * pdfcropmargins each spawn a real process, and 20 concurrent ones would put
 * the OOM killer in charge. They are single-threaded and CPU bound, so running
 * them in parallel buys little anyway.
 */
async function storeBatch (key, info, body, files) {
  const results = []
  let remainingSlots = maxFilesPerKey - info.files.length
  let remainingBytes = maxKeyBytes - info.bytes
  let aborted = null

  info.busy++
  try {
    for (const file of files) {
      if (aborted) {
        unlinkQuiet(file.path)
        results.push({ok: false, originalName: file.originalname, error: aborted})
        continue
      }

      if (remainingSlots <= 0 || file.size > remainingBytes) {
        unlinkQuiet(file.path)
        results.push({
          ok: false,
          originalName: file.originalname,
          error: 'Storage limit for this key reached (max ' + maxFilesPerKey + ' files / ' + formatMB(maxKeyBytes) + '). Download the waiting files or let the key expire first.'
        })
        continue
      }

      // Keep the key alive across a long conversion even if the ereader has
      // stopped polling (screen asleep, wifi dropped).
      expireKey(key)
      const result = await processUploadedFile(file, info, body)
      expireKey(key)

      if (!result.ok) {
        results.push(result)
        continue
      }

      if (app.context.keys.get(key) !== info) {
        // The key expired or was regenerated while we were converting. Anything
        // we store now would be unreachable and never cleaned up.
        unlinkQuiet(result.path)
        aborted = 'Key ' + key + ' expired during upload'
        results.push({ok: false, originalName: result.originalName, error: aborted})
        continue
      }

      result.name = uniqueName(info, result.name)
      info.files.push({
        name: result.name,
        path: result.path,
        size: result.size,
        conversion: result.conversion,
        uploaded: new Date()
      })
      // Charged against the output size: the input is gone once converted, and
      // a .mobi is routinely larger than the .epub it came from.
      info.bytes += result.size
      remainingSlots--
      remainingBytes -= result.size
      results.push(result)
    }
  } finally {
    info.busy--
    if (info.pendingRemoval && info.busy === 0) removeKey(key)
  }

  return results
}

router.post('/upload', async (ctx, next) => {

  // Reject an oversized batch before multer writes a single byte to disk. Not
  // calling writeContinue() here is deliberate: a client that sent
  // Expect: 100-continue (curl does, for large bodies) then aborts without
  // transmitting the body at all.
  const declared = Number(ctx.request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBatchBytes + multipartOverhead) {
    flash(ctx, {
      success: false,
      status: 413,
      message: 'Upload too large: ' + formatMB(declared) + '. The limit is ' + formatMB(maxBatchBytes) + ' per upload.'
    })
    return
  }

  try {
    await upload.array('file', maxFilesPerBatch)(ctx, () => {})
  } catch (err) {
    cleanupRequestFiles(ctx)
    flash(ctx, multerError(err))
    await next()
    return
  }

  ctx.res.writeContinue()

  const body = ctx.request.body || {}
  const key = String(body.key || '').toUpperCase()
  const files = ctx.request.files || []

  if (files.length > 0) {
    console.log('Uploaded files:', files.map((file) => file.originalname))
  }

  if (!ctx.keys.has(key)) {
    flash(ctx, {
      message: 'Unknown key ' + key,
      success: false
    })
    for (const file of files) {
      unlinkQuiet(file.path)
    }
    await next()
    return
  }

  const info = ctx.keys.get(key)
  expireKey(key)

  let url = null
  if (body.url) {
    url = body.url.trim()
    if (url.length > 0 && !info.urls.includes(url)) {
      info.urls.push(url)
    }
  }

  // Backstop for a chunked request, which carries no content-length to precheck
  const batchBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (batchBytes > maxBatchBytes) {
    for (const file of files) {
      unlinkQuiet(file.path)
    }
    flash(ctx, {
      success: false,
      status: 413,
      message: 'Upload too large: ' + formatMB(batchBytes) + '. The limit is ' + formatMB(maxBatchBytes) + ' per upload.'
    })
    await next()
    return
  }

  // Serialize per key so two tabs can't both read info.bytes before either writes
  const batch = info.lock.catch(() => {}).then(() => storeBatch(key, info, body, files))
  info.lock = batch.catch(() => {})
  const results = await batch

  for (const file of files) {
    file.skip = true
  }

  const succeeded = results.filter((result) => result.ok)
  const failed = results.filter((result) => !result.ok)
  const device = info.agent.includes('Kobo') ? 'a Kobo device.' : (info.agent.includes('Kindle') ? 'a Kindle device.' : 'a device.')

  let messages = []
  if (succeeded.length > 0) {
    messages.push('Upload successful! Sent ' + succeeded.length + ' file' + (succeeded.length === 1 ? '' : 's') + ' to ' + device)
    for (const result of succeeded) {
      messages.push('✓ ' + result.name + (result.conversion ? ' (converted with ' + result.conversion + ')' : ''))
    }
  }
  for (const result of failed) {
    messages.push('✗ ' + result.originalName + ' — ' + result.error)
  }
  if (url) {
    messages.push("Added url: " + url)
  }

  if (messages.length === 0) {
    flash(ctx, {
      message: 'No file or url selected',
      success: false,
      key: key
    })
    await next()
    return
  }

  if (files.length > 0) {
    ctx.set('X-Upload-Result', succeeded.length + '/' + results.length)
  }

  // Success if anything landed. The client renders a success body as HTML and an
  // error body as preformatted text, so the separator has to match.
  const success = succeeded.length > 0 || (failed.length === 0 && !!url)

  flash(ctx, {
    message: success ? messages.map(escapeHtml).join('<br/>') : messages.join('\n'),
    success: success,
    key: key,
    url: url
  })

  await next()
})

router.delete('/file/:key', async ctx => {
  const key = ctx.params.key.toUpperCase()
  const info = ctx.keys.get(key)
  if (!info) {
    ctx.throw(400, 'Unknown key: ' + key)
  }
  for (const file of info.files) {
    unlinkQuiet(file.path)
  }
  info.files = []
  info.bytes = 0
  ctx.body = 'ok'
})

router.delete('/file/:key/:filename', async ctx => {
  const key = ctx.params.key.toUpperCase()
  const info = ctx.keys.get(key)
  if (!info) {
    ctx.throw(400, 'Unknown key: ' + key)
  }
  const index = info.files.findIndex((file) => file.name === ctx.params.filename)
  if (index === -1) {
    ctx.throw(404, 'Unknown file: ' + ctx.params.filename)
  }
  const [file] = info.files.splice(index, 1)
  info.bytes = Math.max(0, info.bytes - file.size)
  unlinkQuiet(file.path)
  ctx.body = 'ok'
})

router.get('/status/:key', async ctx => {
  const key = ctx.params.key.toUpperCase()
  const info = ctx.keys.get(key)
  if (!info) {
    ctx.response.status = 404
    ctx.body = {error: 'Unknown key'}
    return
  }
  if (info.agent !== ctx.get('user-agent')) {
    // don't send this error to client
    console.error("User Agent doesnt match: " + info.agent + " VS " + ctx.get('user-agent'))
    return
  }
  expireKey(key)
  // ctx.cookies.set('key', key, {overwrite: true, httpOnly: false, sameSite: 'strict', maxAge: expireDelay * 1000})
  ctx.body = {
    alive: info.alive,
    files: info.files.map((file) => ({
      name: file.name
      // size: file.size
    })),
    // Deprecated, kept for ereaders still running a cached copy of the old
    // download.html, which reads data.file and knows nothing about data.files.
    file: info.files.length > 0 ? {name: info.files[info.files.length - 1].name} : null,
    urls: info.urls
  }
})

router.get('/receive', async ctx => {
  await sendfile(ctx, 'static/download.html')
})

router.get('/', async ctx => {
  const agent = ctx.get('user-agent')
  console.log(ctx.ip, agent)
  await sendfile(ctx, agent.includes('Kobo') || agent.includes('Kindle') || agent.toLowerCase().includes('tolino') || agent.includes('eReader') /*"eReader" is on Tolino*/ ? 'static/download.html' : 'static/upload.html')
})

router.get('/:filename', downloadFile)

app.use(serve("static"))

app.use(router.routes())
app.use(router.allowedMethods())


// force: uploads is gitignored, so it doesn't exist on a fresh checkout
fs.rm('uploads', {recursive: true, force: true}, (err) => {
  if (err) throw err
  mkdirp('uploads').then (() => {
    // app.listen(port)
    const fn = app.callback()
    const server = http.createServer(fn)
    server.on('checkContinue', (req, res) => {
      console.log("check continue!")
      fn(req, res)
    })
    // Node's 5 minute default is the time allowed to receive the *whole* request,
    // which a 1 GB upload needs ~28 Mbit/s of upstream to beat.
    server.requestTimeout = requestTimeout
    server.listen(port)
    console.log('server is listening on port ' + port)
  })
})
