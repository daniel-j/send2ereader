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
const maxFileSize = 1024 * 1024 * 800  // 800 MB

const TYPE_EPUB = 'application/epub+zip' // the official IANA standard

const TYPE_MOBI = 'application/x-mobipocket-ebook'

const allowedTypes = [TYPE_EPUB, TYPE_MOBI, 'application/pdf', 'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar', 'text/html', 'text/plain', 'application/zip', 'application/x-rar-compressed', 'application/epub']
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

function removeKey (key) {
  console.log('Removing expired key', key)
  const info = app.context.keys.get(key)
  if (info) {
    clearTimeout(app.context.keys.get(key).timer)
    if (info.file) {
      console.log('Deleting file', info.file.path)
      fs.unlink(info.file.path, (err) => {
        if (err) console.error(err)
      })
      info.file = null
    }
    app.context.keys.delete(key)
  } else {
    console.log('Tried to remove non-existing key', key)
  }
}

function expireKey (key) {
  // console.log('key', key, 'will expire in', expireDelay, 'seconds')
  const info = app.context.keys.get(key)
  const timer = setTimeout(removeKey, expireDelay * 1000, key)
  if (info) {
    clearTimeout(info.timer)
    info.timer = timer
    info.alive = new Date()
  }
  return timer
}

function flash (ctx, data) {
  console.log(data)
  //ctx.cookies.set('flash', encodeURIComponent(JSON.stringify(data)), {overwrite: true, httpOnly: false, sameSite: 'strict', maxAge: 10 * 1000})
  ctx.response.status = data.success ? 200 : 400
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
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Fixes charset
    // https://github.com/expressjs/multer/issues/1104#issuecomment-1152987772
    file.originalname = sanitize(Buffer.from(file.originalname, 'latin1').toString('utf8'))

    console.log('Incoming file:', file)
    const key = req.body.key.toUpperCase()
    if (!app.context.keys.has(key)) {
      console.error('FileFilter: Unknown key: ' + key)
      cb("Unknown key " + key, false)
      return
    }
    
    // Handle application/epub mimetype
    if (file.mimetype === "application/epub") {
      file.mimetype = TYPE_EPUB
    }
    
    const fileExtension = extname(file.originalname.toLowerCase()).substring(1)
    const isValidMimetype = allowedTypes.includes(file.mimetype) || file.mimetype === "application/octet-stream"
    const isValidExtension = allowedExtensions.includes(fileExtension)
    
    if (!isValidMimetype || !isValidExtension) {
      console.error('FileFilter: File is of an invalid type ', file)
      cb("Invalid filetype: " + JSON.stringify(file), false)
      return
    }
    cb(null, true)
  }
})

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
    file: null,
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

  if (!info || !info.file) {
    await next()
    return
  }

  ctx.redirect('/' + encodeURIComponent(info.file.name));
})
*/

async function downloadFile (ctx, next) {
  const key = ctx.query.key
  if (!key) {
    await next()
    return
  }

  const filename = decodeURIComponent(ctx.params.filename)
  const info = ctx.keys.get(key)

  if (!info || !info.file || info.file.name !== filename) {
    await next()
    return
  }
  if (info.agent !== ctx.get('user-agent')) {
    console.error("User Agent doesnt match: " + info.agent + " VS " + ctx.get('user-agent'))
    return
  }
  expireKey(key)
  console.log('Sending file', [info.file.path, info.file.name])
  if (info.agent.includes('Kindle')) {
    // Kindle needs a safe name or it thinks it's an invalid file
    ctx.attachment(info.file.name)
  }
  await sendfile(ctx, info.file.path)
}

router.post('/upload', async (ctx, next) => {

  try {
    await upload.single('file')(ctx, () => {})
  } catch (err) {
    flash(ctx, {
      message: err,
      success: false
    })
    // ctx.throw(400, err)
    // ctx.res.end(err)
    await next()
    return
  }

  ctx.res.writeContinue()

  const key = ctx.request.body.key.toUpperCase()

  if (ctx.request.file) {
    console.log('Uploaded file:', ctx.request.file)
  }

  if (!ctx.keys.has(key)) {
    flash(ctx, {
      message: 'Unknown key ' + key,
      success: false
    })
    if (ctx.request.file) {
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
    }
    await next()
    return
  }

  const info = ctx.keys.get(key)
  expireKey(key)

  let url = null
  if (ctx.request.body.url) {
    url = ctx.request.body.url.trim()
    if (url.length > 0 && !info.urls.includes(url)) {
      info.urls.push(url)
    }
  }

  let conversion = null
  let filename = ""

  if (ctx.request.file) {
    if (ctx.request.file.size === 0) {
      let data = {
        message: 'Invalid file submitted (empty file)',
        success: false,
        key: key
      }
      flash(ctx, data)
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
      await next()
      return
    }

    let mimetype = ctx.request.file.mimetype
    console.log('Second validation - Original mimetype:', mimetype)

    const type = await FileType.fromFile(ctx.request.file.path)
    console.log('Second validation - FileType detection result:', type)

    if (mimetype == "application/octet-stream" && type) {
      mimetype = type.mime
      console.log('Second validation - Updated mimetype from octet-stream:', mimetype)
    }

    if (mimetype == "application/epub") {
      mimetype = TYPE_EPUB
      console.log('Second validation - Converted application/epub to:', TYPE_EPUB)
    }

    // Convert application/epub to application/epub+zip for consistency
    if (type && type.mime === "application/epub") {
      type.mime = TYPE_EPUB
      console.log('Second validation - Converted type.mime from application/epub to:', TYPE_EPUB)
    }
    
    const isValidTypeMime = type && allowedTypes.includes(type.mime)
    const isValidMimetype = allowedTypes.includes(mimetype)
    
    console.log('Second validation - Is valid type.mime:', isValidTypeMime)
    console.log('Second validation - Is valid mimetype:', isValidMimetype)
    console.log('Second validation - Final type.mime:', type ? type.mime : 'null')
    console.log('Second validation - Final mimetype:', mimetype)
    
    if (!isValidTypeMime && !isValidMimetype) {
      console.error('Second validation - Invalid file type detected')
      flash(ctx, {
        message: 'Uploaded file is of an invalid type: ' + ctx.request.file.originalname + ' (' + (type? type.mime : 'unknown mimetype') + ')',
        success: false,
        key: key
      })
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
      await next()
      return
    }

    let data = null
    filename = ctx.request.file.originalname
    if (ctx.request.body.transliteration) {
      filename = sanitize(doTransliterate(filename))
    }
    if (info.agent.includes('Kindle')) {
      filename = filename.replace(/[^\.\w\-"'\(\)]/g, '_')
    }

    if (mimetype === TYPE_EPUB && info.agent.includes('Kindle') && ctx.request.body.kindlegen) {
      // convert to .mobi
      conversion = 'kindlegen'
      const outname = ctx.request.file.path.replace(/\.epub$/i, '.mobi')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi')
      let stderr = ''

      let p = new Promise((resolve, reject) => {
        const kindlegen = spawn('kindlegen', [basename(ctx.request.file.path), '-dont_append_source', '-c1', '-o', basename(outname)], {
          // stdio: 'inherit',
          cwd: dirname(ctx.request.file.path)
        })
        kindlegen.once('error', function (err) {
          fs.unlink(ctx.request.file.path, (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path)
          })
          fs.unlink(ctx.request.file.path.replace(/\.epub$/i, '.mobi8'), (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path.replace(/\.epub$/i, '.mobi8'))
          })
          reject('kindlegen error: ' + err)
        })
        kindlegen.once('close', (code) => {
          fs.unlink(ctx.request.file.path, (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path)
          })
          fs.unlink(ctx.request.file.path.replace(/\.epub$/i, '.mobi8'), (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path.replace(/\.epub$/i, '.mobi8'))
          })
          if (code !== 0 && code !== 1) {
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
        flash(ctx, {
          success: false,
          message: err.replaceAll(basename(ctx.request.file.path), "infile.epub").replaceAll(basename(outname), "outfile.mobi")
        })
        return
      }

    } else if (mimetype === TYPE_EPUB && info.agent.includes('Kobo') && ctx.request.body.kepubify) {
      // convert to Kobo EPUB
      conversion = 'kepubify'
      const outname = ctx.request.file.path.replace(/\.epub$/i, '.kepub.epub')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub')

      let p = new Promise((resolve, reject) => {
        let stderr = ''
        const kepubify = spawn('kepubify', ['-v', '-u', '-o', basename(outname), basename(ctx.request.file.path)], {
          //stdio: 'inherit',
          cwd: dirname(ctx.request.file.path)
        })
        kepubify.once('error', function (err) {
          fs.unlink(ctx.request.file.path, (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path)
          })
          reject('kepubify error: ' + err)
        })
        kepubify.once('close', (code) => {
          fs.unlink(ctx.request.file.path, (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path)
          })
          if (code !== 0) {
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
        flash(ctx, {
          success: false,
          message: err.replaceAll(basename(ctx.request.file.path), "infile.epub").replaceAll(basename(outname), "outfile.kepub.epub")
        })
        return
      }

    } else if (mimetype == 'application/pdf' && ctx.request.body.pdfcropmargins) {
      const dir = dirname(ctx.request.file.path)
      const base = basename(ctx.request.file.path, '.pdf')
      const outfile = resolvepath(join(dir, `${base}_cropped.pdf`))
      let p = new Promise((resolve, reject) => {
        let stderr = ''
        const pdfcropmargins = spawn('pdfcropmargins', ['-s', '-u', '-o', outfile, basename(ctx.request.file.path)], {
          // stdio: 'inherit',
          cwd: dirname(ctx.request.file.path)
        })
        pdfcropmargins.once('error', function (err) {
          fs.unlink(ctx.request.file.path, (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path)
          })
          reject('pdfcropmargins error: ' + err)
        })
        pdfcropmargins.once('close', (code) => {
          fs.unlink(ctx.request.file.path, (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path)
          })
          if (code !== 0) {
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
        flash(ctx, {
          success: false,
          message: err.replaceAll(basename(ctx.request.file.path), "infile.pdf").replaceAll(outfile, "outfile.pdf")
        })
        return
      }

    } else {
      // No conversion
      data = ctx.request.file.path
      filename = filename.replace(/\.epub$/i, '.epub').replace(/\.pdf$/i, '.pdf')
    }

    expireKey(key)
    if (info.file && info.file.path) {
      await new Promise((resolve, reject) => fs.unlink(info.file.path, (err) => {
        if (err) return reject(err)
        else console.log('Removed previously uploaded file', info.file.path)
        resolve()
      }))
    }
    info.file = {
      name: filename,
      path: data,
      // size: ctx.request.file.size,
      uploaded: new Date()
    }
  }

  let messages = []
  if (ctx.request.file) {
    ctx.request.file.skip = true
    messages.push('Upload successful! ' + (conversion ? 'Ebook was converted with ' + conversion + ' and sent' : 'Sent')+' to '+(info.agent.includes('Kobo') ? 'a Kobo device.' : (info.agent.includes('Kindle') ? 'a Kindle device.' : 'a device.')))
    messages.push('Filename: ' + filename)
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

  flash(ctx, {
    message: messages.join("<br/>"),
    success: true,
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
  info.file = null
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
    file: info.file ? {
      name: info.file.name,
      // size: info.file.size
    } : null,
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

fs.access('uploads', (accessErr) => {
  const setupServer = () => {
    mkdirp('uploads').then(() => {
      const fn = app.callback()
      const server = http.createServer(fn)
      server.on('checkContinue', (req, res) => {
        console.log("check continue!")
        fn(req, res)
      })
      server.listen(port)
      console.log('server is listening on port ' + port)
    })
  }

  if (accessErr) {
    // Directory doesn't exist, just create it
    setupServer()
  } else {
    // Directory exists, remove it first then recreate
    fs.rm('uploads', { recursive: true }, (err) => {
      if (err) throw err
      setupServer()
    })
  }
})
