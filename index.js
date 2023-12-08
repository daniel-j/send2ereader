#!/usr/bin/env node

const Koa = require('koa')
const Router = require('@koa/router')
const multer = require('@koa/multer')
const logger = require('koa-logger')
const sendfile = require('koa-sendfile')
const serve = require('koa-static')
const mount = require('koa-mount')
const { mkdirp } = require('mkdirp')
const fs = require('fs')
const { spawn } = require('child_process')
const { extname, basename, dirname } = require('path')
const FileType = require('file-type')
const { transliterate } = require('transliteration')

const port = 3001
const expireDelay = 30  // 30 seconds
const maxExpireDuration = 1 * 60 * 60  // 1 hour
const maxFileSize = 1024 * 1024 * 800  // 800 MB

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
  ctx.cookies.set('flash', encodeURIComponent(JSON.stringify(data)), {overwrite: true, httpOnly: false, sameSite: 'strict', maxAge: 10 * 1000})
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
    file.originalname = doTransliterate(Buffer.from(file.originalname, 'latin1').toString('utf8'))

    console.log('Incoming file:', file)
    const key = req.body.key.toUpperCase()
    if (!app.context.keys.has(key)) {
      console.error('FileFilter: Unknown key: ' + key)
      cb(null, false)
      return
    }
    if ((!allowedTypes.includes(file.mimetype) && file.mimetype != "application/octet-stream") || !allowedExtensions.includes(extname(file.originalname.toLowerCase()).substring(1))) {
      console.error('FileFilter: File is of an invalid type ', file)
      cb(null, false)
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

  ctx.body = key
})

router.get('/download/:key', async ctx => {
  const key = ctx.params.key.toUpperCase()
  const info = ctx.keys.get(key)
  if (!info || !info.file) {
    return
  }
  if (info.agent !== ctx.get('user-agent')) {
    console.error("User Agent doesnt match: " + info.agent + " VS " + ctx.get('user-agent'))
    return
  }
  expireKey(key)
  // const fallback = basename(info.file.path)
  const sanename = info.file.name.replace(/[^\.\w\-"'\(\)]/g, '_')
  console.log('Sending file', [info.file.path, info.file.name, sanename])
  await sendfile(ctx, info.file.path)
  if (info.agent.includes('Kindle')) {
    // Kindle needs a safe name or it thinks it's an invalid file
    ctx.attachment(sanename)
  } else {
    // Kobo always uses fallback
    ctx.attachment(info.file.name, {fallback: sanename})
  }
})

router.post('/upload', upload.single('file'), async ctx => {
  const key = ctx.request.body.key.toUpperCase()

  if (ctx.request.file) {
    console.log('Uploaded file:', ctx.request.file)
  }

  if (!ctx.keys.has(key)) {
    flash(ctx, {
      message: 'Unknown key ' + key,
      success: false
    })
    ctx.redirect('back', '/')
    if (ctx.request.file) {
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
    }
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
      flash(ctx, {
        message: 'Invalid file submitted',
        success: false,
        key: key
      })
      ctx.redirect('back', '/')
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
      return
    }

    let mimetype = ctx.request.file.mimetype

    const type = await FileType.fromFile(ctx.request.file.path)

    if (mimetype == "application/octet-stream" && type) {
      mimetype = type.mime
    }

    if ((!type || !allowedTypes.includes(type.mime)) && !allowedTypes.includes(mimetype)) {
      flash(ctx, {
        message: 'Uploaded file is of an invalid type: ' + ctx.request.file.originalname + ' (' + (type? type.mime : 'unknown mimetype') + ')',
        success: false,
        key: key
      })
      ctx.redirect('back', '/')
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
      return
    }

    let data = null
    filename = ctx.request.file.originalname

    if (mimetype === TYPE_EPUB && info.agent.includes('Kindle')) {
      // convert to .mobi
      conversion = 'kindlegen'
      const outname = ctx.request.file.path.replace(/\.epub$/i, '.mobi')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi')

      data = await new Promise((resolve, reject) => {
        const kindlegen = spawn('kindlegen', [basename(ctx.request.file.path), '-dont_append_source', '-c1', '-o', basename(outname)], {
          stdio: 'inherit',
          cwd: dirname(ctx.request.file.path)
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
          if (code !== 0) {
            console.warn('kindlegen error code ' + code)
          }

          resolve(outname)
        })
      })

    } else if (mimetype === TYPE_EPUB && info.agent.includes('Kobo') && ctx.request.body.kepubify) {
      // convert to Kobo EPUB
      conversion = 'kepubify'
      const outname = ctx.request.file.path.replace(/\.epub$/i, '.kepub.epub')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub')

      data = await new Promise((resolve, reject) => {
        const kepubify = spawn('kepubify', ['-v', '-u', '-o', basename(outname), basename(ctx.request.file.path)], {
          stdio: 'inherit',
          cwd: dirname(ctx.request.file.path)
        })
        kepubify.once('close', (code) => {
          fs.unlink(ctx.request.file.path, (err) => {
            if (err) console.error(err)
            else console.log('Removed file', ctx.request.file.path)
          })
          if (code !== 0) {
            reject('kepubify error code ' + code)
            return
          }

          resolve(outname)
        })
      })
    } else {
      // No conversion
      data = ctx.request.file.path
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
    messages.push('Upload successful! ' + (conversion ? ' Ebook was converted with ' + conversion + ' and sent' : ' Sent')+' to '+(info.agent.includes('Kobo') ? 'a Kobo device.' : (info.agent.includes('Kindle') ? 'a Kindle device.' : 'a device.')))
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
    ctx.redirect('back', '/')
    return
  }

  flash(ctx, {
    message: messages.join("<br/>"),
    success: true,
    key: key,
    url: url
  })
  ctx.redirect('back', '/')
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
    ctx.body = {error: 'Unknown key'}
    return
  }
  if (info.agent !== ctx.get('user-agent')) {
    // don't send this error to client
    console.error("User Agent doesnt match: " + info.agent + " VS " + ctx.get('user-agent'))
    return
  }
  expireKey(key)
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
  await sendfile(ctx, agent.includes('Kobo') || agent.includes('Kindle')? 'static/download.html' : 'static/upload.html')
})


app.use(router.routes())
app.use(router.allowedMethods())

app.use(serve("static"))

fs.rm('uploads', {recursive: true}, (err) => {
  if (err) throw err
  mkdirp('uploads').then (() => {
    app.listen(port)
    console.log('server is listening on port ' + port)
  })
})
