#!/usr/bin/env node

const Koa = require('koa')
const Router = require('@koa/router')
const multer = require('@koa/multer')
const logger = require('koa-logger')
const sendfile = require('koa-sendfile')
const mkdirp = require('mkdirp')
const fs = require('fs')
const { spawn } = require('child_process')

const expireDelay = 20
const port = 3001
const maxFileSize = 1024 * 1024 * 400
const keyMin = 1000
const keyMax = 9999

function random(minimum, maximum) {
  return Math.floor((Math.random() * (maximum - minimum + 1)) + minimum)
}

function removeKey (key) {
  console.log('Removing expired key', key)
  const info = app.context.keys.get(key)
  if (info) {
    clearTimeout(app.context.keys.get(key).timer)
    if (info.file) {
      fs.unlink(info.file.path, (err) => {
        if (err) console.error(err)
      })
    }
    app.context.keys.delete(key)
  } else {
    console.log('key dont exist', key)
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

const app = new Koa()
app.context.keys = new Map()
const router = new Router()
const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, 'uploads')
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      console.log(file)
      cb(null, file.fieldname + '-' + uniqueSuffix + '.epub')
    }
  }),
  limits: {
    fileSize: maxFileSize,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const key = req.body.key
    if (!app.context.keys.has(key)) {
      console.error('FileFilter: Unknown key: ' + key)
      cb(null, false)
      return
    }
    if (!file.originalname.toLowerCase().endsWith('.epub')) {
      console.error('FileFilter: Filename does not end with .epub: ' + file.originalname)
      cb(null, false)
      return
    }
    cb(null, true)
  }
})

router.get('/generate', async ctx => {
  const agent = ctx.get('user-agent')
  if (!agent.includes('Kobo')) {
    console.error('Non-Kobo device tried to generate a key: ' + agent)
    ctx.throw(403)
  }
  let key = null
  let attempts = 0
  do {
    key = random(keyMin, keyMax).toString()
    console.log(attempts, ctx.keys.size, key)
    if (attempts > ctx.keys.size) {
      console.error('Can\'t generate more keys, map is full.')
      ctx.body = 'error'
      return
    }
    attempts++
  } while (ctx.keys.has(key))

  const info = {
    created: new Date(),
    agent: agent,
    file: null
  }
  console.log(info)
  ctx.keys.set(key, info)
  expireKey(key)

  ctx.body = key
})

router.get('/download/:key', async ctx => {
  const key = ctx.params.key
  const info = ctx.keys.get(key)
  if (!info || !info.file) {
    return
  }
  if (info.agent !== ctx.get('user-agent')) {
    throw new Error("User Agent doesnt match: " + info.agent + " VS " + ctx.get('user-agent'))
  }
  expireKey(key)
  console.log('Sending file!')
  await sendfile(ctx, info.file.path)
  // ctx.type = 'application/epub+zip'
  ctx.attachment(info.file.name)
})

router.post('/upload', upload.single('file'), async ctx => {
  const key = ctx.request.body.key

  if (!ctx.keys.has(key)) {
    ctx.throw(400, 'Unknown key: ' + key)
  }
  if (!ctx.request.file.originalname.toLowerCase().endsWith('.epub')) {
    ctx.throw(400, 'Uploaded file does not end with .epub ' + ctx.request.file.originalname)
  }

  if (!ctx.request.file || ctx.request.file.size === 0) {
    ctx.throw(400, 'Invalid or no file submitted')
  }

  let data = null
  let filename = ctx.request.file.originalname

  if (ctx.request.body.kepubify) {
    const outname = ctx.request.file.path.replace(/\.epub$/i, '.kepub.epub')

    filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub')

    data = await new Promise((resolve, reject) => {
      const kepubify = spawn('kepubify', ['-v', '-u', '-o', outname, ctx.request.file.path], {
        stdio: 'inherit'
      })
      kepubify.once('close', (code) => {
        fs.unlink(ctx.request.file.path, (err) => {
          if (err) console.error(err)
        })
        if (code !== 0) {
          reject('kepubify error code ' + code)
          return
        }

        resolve(outname)
      })
    })
  } else {
    data = ctx.request.file.path
  }

  expireKey(key)
  const info = ctx.keys.get(key)
  if (info.file && info.file.path) {
    await new Promise((resolve, reject) => fs.unlink(info.file.path, (err) => {
      if (err) reject(err)
      resolve()
    }))
  }
  info.file = {
    name: filename,
    path: data,
    // size: ctx.request.file.size,
    uploaded: new Date()
  }
  console.log(info.file)
  ctx.redirect('back', '/')
})

router.delete('/file/:key', async ctx => {
  const key = ctx.params.key
  const info = ctx.keys.get(key)
  if (!info) {
    ctx.throw(400, 'Unknown key: ' + key)
  }
  info.file = null
  ctx.body = 'ok'
})

router.get('/status/:key', async ctx => {
  const key = ctx.params.key
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
    } : null
  }
})

router.get('/style.css', async ctx => {
  await sendfile(ctx, 'style.css')
})

router.get('/', async ctx => {
  const agent = ctx.get('user-agent')
  console.log(agent)
  await sendfile(ctx, agent.includes('Kobo') ? 'download.html' : 'upload.html')
})

app.use(logger())
app.use(router.routes())
app.use(router.allowedMethods())

fs.rmdir('uploads', {recursive: true}, (err) => {
  if (err) throw err
  mkdirp('uploads').then (() => {
    app.listen(port)
    console.log('server is listening on port ' + port)
  })
})
