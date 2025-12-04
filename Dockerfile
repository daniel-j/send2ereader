# node 20 is lts at the time of writing
FROM docker.io/library/node:lts-alpine AS build

# Create app directory
WORKDIR /usr/src/app

RUN apk add --no-cache pipx gcc g++ make pkgconf python3-dev

ENV PATH="$PATH:/root/.local/bin"

RUN pipx install pdfCropMargins

FROM docker.io/library/node:lts-alpine as runtime

# Copy pdfCropMargins install
COPY --from=build /root/.local /root/.local

RUN apk add --no-cache python3

ENV PATH="$PATH:/root/.local/bin"

# Download and install kepubify
RUN wget https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit && \
    mv kepubify-linux-64bit /usr/local/bin/kepubify && \
    chmod +x /usr/local/bin/kepubify

# Download and install kindlegen
RUN wget https://github.com/zzet/fp-docker/raw/f2b41fb0af6bb903afd0e429d5487acc62cb9df8/kindlegen_linux_2.6_i386_v2_9.tar.gz && \
    echo "9828db5a2c8970d487ada2caa91a3b6403210d5d183a7e3849b1b206ff042296 kindlegen_linux_2.6_i386_v2_9.tar.gz" | sha256sum -c && \
    mkdir kindlegen && \
    tar xvf kindlegen_linux_2.6_i386_v2_9.tar.gz --directory kindlegen && \
    cp kindlegen/kindlegen /usr/local/bin/kindlegen && \
    chmod +x /usr/local/bin/kindlegen && \
    rm -rf kindlegen

# Copy files needed by npm install
COPY package*.json ./

# Install app dependencies
RUN npm install --omit=dev

# Copy the rest of the app files (see .dockerignore)
COPY . ./

# Create uploads directory if it doesn't exist
RUN mkdir uploads

EXPOSE 3001
CMD [ "npm", "start" ]
