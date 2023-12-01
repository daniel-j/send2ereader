# send2ereader

A self hostable service for sending ebooks to a Kobo or Kindle ereader through the built-in browser.

## How To Run

### On Your Host OS

1. Have Node 16 installed
2. Install this service's dependencies by running `$ npm install`
3. Install [Kepubify](https://github.com/pgaskin/kepubify), and have the executable in your path.
4. Start this service by running: `$ node index`

### Containerized

1. Have Docker installed
2. Run `$ docker compose up`
