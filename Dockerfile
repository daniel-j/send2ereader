FROM node:20-slim

# Install system dependencies:
# - curl: for downloading kepubify
# - python3, python3-pip: for pdfCropMargins
# - lib32z1, lib32gcc-s1, lib32stdc++6: for running 32-bit kindlegen binary
# - ghostscript, pdftoppm (poppler-utils): required by pdfCropMargins
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    python3-pip \
    lib32z1 \
    lib32gcc-s1 \
    lib32stdc++6 \
    ghostscript \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install kepubify — pinned to v4.0.4 (latest stable as of 2022-03-09)
# To upgrade: change the version tag and update this comment
RUN curl -fsSL \
    https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit \
    -o /usr/local/bin/kepubify \
    && chmod +x /usr/local/bin/kepubify

# Install pdfCropMargins via pip
RUN pip3 install pdfCropMargins --break-system-packages

# Copy the pre-committed kindlegen binary (32-bit, abandonware — no stable
# upstream URL, so it lives in bin/ in this repo)
COPY bin/kindlegen /usr/local/bin/kindlegen
RUN chmod +x /usr/local/bin/kindlegen

# Install Node dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

# Copy application source
COPY . .

EXPOSE 3001
CMD ["node", "index"]
