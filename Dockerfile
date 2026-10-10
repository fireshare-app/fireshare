FROM node:24-slim AS client
WORKDIR /app
ENV PATH=/app/node_modules/.bin:$PATH
COPY app/client/package.json ./
COPY app/client/package-lock.json ./
COPY app/client/.env.* ./
RUN npm ci --silent
COPY app/client/ ./
RUN npm run build

# FFmpeg builder stage with CUDA development tools
FROM nvidia/cuda:11.8.0-devel-ubuntu22.04 AS ffmpeg-builder
WORKDIR /tmp

# Install build dependencies
# Remove stale NVIDIA apt sources (GPG keys rotate) and swap archive.ubuntu.com
# for kernel.org's mirror, which is accessible when Canonical's servers aren't
RUN rm -f /etc/apt/sources.list.d/cuda.list /etc/apt/sources.list.d/nvidia-ml.list \
    && sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.edge.kernel.org/ubuntu|g' /etc/apt/sources.list
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    pkg-config \
    yasm \
    nasm \
    git \
    wget \
    xz-utils \
    ca-certificates \
    libx264-dev \
    libx265-dev \
    libvpx-dev \
    libaom-dev \
    libdav1d-dev \
    libopus-dev \
    libvorbis-dev \
    libass-dev \
    libfreetype6-dev \
    libmp3lame-dev \
    libwebp-dev \
    libzimg-dev \
    libvulkan-dev \
    glslang-dev \
    spirv-tools \
    liblcms2-dev \
    python3 \
    python3-pip \
    ninja-build \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir 'meson>=1.0'

# Build SVT-AV1 from source, V1.8.0 for FFmpeg 6.1
RUN git clone --depth 1 --branch v1.8.0 https://gitlab.com/AOMediaCodec/SVT-AV1.git && \
    cd SVT-AV1/Build && \
    cmake .. -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release && \
    make -j$(nproc) && \
    make install

# Vulkan headers for FFmpeg 6.1's Vulkan code, which wants >= 1.3.255 (jammy ships 1.3.204).
# Header-only; the loader stays jammy's libvulkan1.
RUN git clone --depth 1 --branch v1.3.255 https://github.com/KhronosGroup/Vulkan-Headers.git && \
    cmake -S Vulkan-Headers -B Vulkan-Headers/build -DCMAKE_INSTALL_PREFIX=/usr/local && \
    cmake --install Vulkan-Headers/build && rm -rf Vulkan-Headers

# libplacebo, for the bt.2390 HDR -> SDR tone map. Built from source because jammy's
# 4.192 does not compile against FFmpeg 6.1's filter; v6.338 is the series 6.1 was
# developed against. jammy's static glslang is linked in, so it needs no runtime package.
RUN git clone --depth 1 --recursive --branch v6.338.2 https://github.com/haasn/libplacebo.git && \
    cd libplacebo && \
    meson setup build --prefix=/usr/local --libdir=lib --buildtype=release \
        -Dvulkan=enabled -Dglslang=enabled -Dshaderc=disabled -Dlcms=enabled \
        -Dopengl=disabled -Dd3d11=disabled -Ddemos=false -Dtests=false && \
    ninja -C build && ninja -C build install && ldconfig && \
    cd .. && rm -rf libplacebo

# Install NVIDIA codec headers for NVENC support
RUN git clone --depth 1 --branch n12.1.14.0 https://github.com/FFmpeg/nv-codec-headers.git && \
    cd nv-codec-headers && \
    make install && \
    ldconfig

# Download and extract FFmpeg
RUN wget -q https://ffmpeg.org/releases/ffmpeg-6.1.tar.xz && \
    tar -xf ffmpeg-6.1.tar.xz

# Configure FFmpeg with NVENC and all necessary encoders. libzimg provides zscale, which
# the HDR -> SDR tone map needs to get frames into linear light.
RUN cd ffmpeg-6.1 && \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/share/pkgconfig ./configure \
        --prefix=/usr/local \
        --enable-gpl \
        --enable-version3 \
        --enable-nonfree \
        --enable-ffnvcodec \
        --enable-libx264 \
        --enable-libx265 \
        --enable-libvpx \
        --enable-libaom \
        --enable-libdav1d \
        --enable-libopus \
        --enable-libvorbis \
        --enable-libmp3lame \
        --enable-libass \
        --enable-libfreetype \
        --enable-libsvtav1 \
        --enable-libwebp \
        --enable-libzimg \
        --enable-libplacebo \
        --enable-vulkan \
        --disable-debug \
        --disable-doc

# Build and install FFmpeg
RUN cd ffmpeg-6.1 && \
    make -j$(nproc) && \
    make install && \
    ldconfig

# Verify FFmpeg was built correctly, with the tone map filters
RUN ffmpeg -version && \
    ffmpeg -hide_banner -filters | grep -E ' (zscale|tonemap|libplacebo)[ ]' && \
    ffmpeg -hide_banner -encoders 2>/dev/null | grep -E "(nvenc|264|265|vpx|aom|svt)" | head -20

# Python build stage — compiles Python 3.14 from source; works on all architectures
FROM ubuntu:22.04 AS python-source
ARG PYTHON_VERSION=3.14.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential wget xz-utils ca-certificates \
    libssl-dev libffi-dev zlib1g-dev \
    libbz2-dev libreadline-dev libsqlite3-dev \
    liblzma-dev uuid-dev \
    && rm -rf /var/lib/apt/lists/*
RUN wget -q https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tar.xz && \
    tar -xf Python-${PYTHON_VERSION}.tar.xz && \
    cd Python-${PYTHON_VERSION} && \
    ./configure \
        --prefix=/opt/python3.14 \
        --enable-shared \
        --with-ensurepip=install \
        LDFLAGS="-Wl,-rpath /opt/python3.14/lib" && \
    make -j$(nproc) && \
    make altinstall && \
    /opt/python3.14/bin/python3.14 -m pip install --upgrade pip && \
    rm -f /tmp/Python-${PYTHON_VERSION}.tar.xz

# Main application stage
FROM nvidia/cuda:11.8.0-runtime-ubuntu22.04
WORKDIR /

# Copy FFmpeg from builder
COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-builder /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg-builder /usr/local/lib/lib* /usr/local/lib/

# Install runtime dependencies
RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
    nginx-extras supervisor \
    libssl-dev \
    libffi-dev libc-dev \
    build-essential \
    gosu \
    ca-certificates \
    tzdata \
    libx264-163 libx265-199 libvpx7 libaom3 libdav1d5 \
    libopus0 libvorbis0a libvorbisenc2 \
    libass9 libfreetype6 libmp3lame0 libwebp7 libwebpmux3 \
    libzimg2 \
    liblcms2-2 libvulkan1 mesa-vulkan-drivers \
    && rm -rf /var/lib/apt/lists/*

COPY --from=python-source /opt/python3.14 /opt/python3.14
RUN echo "/opt/python3.14/lib" > /etc/ld.so.conf.d/python3.14.conf && \
    ldconfig && \
    ln -sf /opt/python3.14/bin/python3.14 /usr/bin/python3.14 && \
    ln -sf /opt/python3.14/bin/python3.14 /usr/bin/python3 && \
    ln -sf /opt/python3.14/bin/python3.14 /usr/bin/python && \
    ln -sf /opt/python3.14/bin/pip3.14 /usr/bin/pip3.14

# Create symlinks and configure library path
RUN ln -sf /usr/local/bin/ffmpeg /usr/bin/ffmpeg && \
    ln -sf /usr/local/bin/ffprobe /usr/bin/ffprobe && \
    echo "/usr/local/lib" > /etc/ld.so.conf.d/usr-local.conf && \
    echo "/usr/local/cuda/lib64" >> /etc/ld.so.conf.d/usr-local.conf && \
    echo "/usr/local/nvidia/lib" >> /etc/ld.so.conf.d/nvidia.conf && \
    echo "/usr/local/nvidia/lib64" >> /etc/ld.so.conf.d/nvidia.conf && \
    ldconfig && \
    ffmpeg -version && \
    echo "Available encoders:" && \
    ffmpeg -hide_banner -encoders 2>/dev/null | grep -E "(nvenc|libaom|libvpx|libx264)" || true

RUN adduser --disabled-password --gecos '' nginx
RUN ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log
RUN mkdir /data && mkdir /processed
COPY entrypoint.sh /
COPY app/nginx/prod.conf /etc/nginx/nginx.conf.template
COPY app/nginx/error.html /etc/nginx/error.html
COPY app/nginx/api_unavailable.html /etc/nginx/api_unavailable.html
COPY app/server/ /app/server
COPY migrations/ /migrations
COPY --from=client /app/build /app/build
COPY --from=client /app/package.json /app
RUN python3.14 -m pip install --no-cache-dir --ignore-installed /app/server \
    && apt-get purge -y --auto-remove \
        libssl-dev \
        libffi-dev libc-dev \
        build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache/pip /tmp/*

ENV FLASK_APP=/app/server/fireshare:create_app()
ENV ENVIRONMENT=production
ENV DATA_DIRECTORY=/data
ENV VIDEO_DIRECTORY=/videos
ENV IMAGE_DIRECTORY=/images
ENV PROCESSED_DIRECTORY=/processed
ENV TEMPLATE_PATH=/app/server/fireshare/templates
ENV ADMIN_PASSWORD=admin
ENV ANALYTICS_TRACKING_SCRIPT=""
ENV TZ=UTC
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64:/usr/local/lib:/usr/local/cuda/lib64:$LD_LIBRARY_PATH
# The NVIDIA Container Toolkit only mounts the NVENC/NVDEC libraries when the
# "video" driver capability is requested, and the Vulkan driver (which lets the
# bt.2390 tone map run on the GPU instead of Mesa's software Vulkan) only with
# "graphics". The CUDA base image defaults to "compute,utility", which leaves
# ffmpeg without libnvidia-encode.so.1 and silently forces CPU transcoding.
# Users may still override this at run time.
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics
ENV PATH=/opt/python3.14/bin:/usr/local/bin:$PATH

EXPOSE 80
CMD ["bash", "/entrypoint.sh"]
