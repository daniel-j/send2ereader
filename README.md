# send2ereader

A self hostable service for sending ebooks to a Kobo or Kindle ereader through the built-in browser.

## How To Run

### On Your Host OS

1. Have Node.js 16 or 20 installed
2. Install this service's dependencies by running `$ npm install`
3. Install [Kepubify](https://github.com/pgaskin/kepubify), and have the kepubify executable in your PATH.
4. Install [KindleGen](https://archive.org/details/kindlegen2.9), and have the kindlegen executable in your PATH.
5. Start this service by running: `$ npm start` and access it on HTTP port 3001

### Containerized

1. Have Docker installed
2. Run `$ docker compose up`
3. Access the service on HTTP port 3001
