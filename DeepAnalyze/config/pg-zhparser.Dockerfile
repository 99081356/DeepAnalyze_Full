FROM pgvector/pgvector:pg17

# Install zhparser (Chinese full-text search parser for PostgreSQL)
# Requires: scws (Simple Chinese Word Segmentation) + zhparser extension
#
# scws uses autotools but does not ship a pre-generated configure script,
# so we must run autoreconf ourselves.
RUN set -e && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        postgresql-server-dev-17 \
        wget \
        ca-certificates \
        autoconf \
        automake \
        libtool \
        pkg-config \
    && \
    update-ca-certificates 2>/dev/null || true && \
    # ---- Step 1: Build and install scws from source ----
    cd /tmp && \
    wget -q "https://github.com/hightman/scws/archive/refs/tags/1.2.3.tar.gz" -O scws.tar.gz && \
    tar xzf scws.tar.gz && \
    cd scws-1.2.3 && \
    autoreconf -fi && \
    ./configure --prefix=/usr && \
    make -j$(nproc) && \
    make install && \
    ldconfig && \
    # ---- Step 2: Build and install zhparser from source ----
    cd /tmp && \
    wget -q "https://github.com/amutu/zhparser/archive/refs/heads/master.tar.gz" -O zhparser.tar.gz && \
    tar xzf zhparser.tar.gz && \
    cd zhparser-master && \
    SCWS_HOME=/usr make && \
    SCWS_HOME=/usr make install && \
    # ---- Step 3: Cleanup ----
    rm -rf /tmp/scws* /tmp/zhparser* && \
    apt-get purge -y autoconf automake libtool pkg-config wget && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
