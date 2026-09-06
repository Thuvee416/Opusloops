# syntax=docker/dockerfile:1.12
# Multi-architecture index digest for python:3.11.13-slim-bookworm.
ARG PYTHON_BASE=python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1

FROM ${PYTHON_BASE} AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY third_party/signalsmith-stretch third_party/signalsmith-stretch
COPY prototypes/stem-tempo-calibration prototypes/stem-tempo-calibration
COPY worker worker

RUN python -m venv /opt/opusloops/venv \
    && /opt/opusloops/venv/bin/python -m pip install \
        pip==25.2 setuptools==84.0.0 wheel==0.46.1 \
    && /opt/opusloops/venv/bin/python -m pip install \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        --constraint worker/constraints.txt \
        torch==2.7.1+cpu torchaudio==2.7.1+cpu \
    && /opt/opusloops/venv/bin/python -m pip install \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        --constraint worker/constraints.txt \
        './prototypes/stem-tempo-calibration[analysis]' ./worker

RUN cmake \
        -S prototypes/stem-tempo-calibration/native \
        -B /tmp/opusloops-native \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/opusloops-native --parallel 4 \
    && install -D -m 0555 \
        /tmp/opusloops-native/opusloops-signalsmith-render \
        /opt/opusloops/bin/opusloops-signalsmith-render

ARG BEAT_THIS_URL=https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt
ARG BEAT_THIS_SHA256=8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331
RUN install -d -m 0755 /opt/opusloops/models/torch/hub/checkpoints \
    && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        --retry 4 --retry-all-errors \
        --output /tmp/beat_this-final0.ckpt "${BEAT_THIS_URL}" \
    && printf '%s  %s\n' "${BEAT_THIS_SHA256}" /tmp/beat_this-final0.ckpt | sha256sum --check --strict \
    && install -m 0444 /tmp/beat_this-final0.ckpt \
        /opt/opusloops/models/torch/hub/checkpoints/beat_this-final0.ckpt \
    && rm /tmp/beat_this-final0.ckpt

RUN /opt/opusloops/venv/bin/opusloops-stem-worker --help >/dev/null \
    && /opt/opusloops/venv/bin/opus-stem-cal --help >/dev/null \
    && test "$(sha256sum /opt/opusloops/models/torch/hub/checkpoints/beat_this-final0.ckpt | cut -d' ' -f1)" = "${BEAT_THIS_SHA256}"

FROM ${PYTHON_BASE} AS runtime

ARG OPUSLOOPS_GIT_COMMIT=unknown
LABEL org.opencontainers.image.title="Opusloops stem worker" \
      org.opencontainers.image.source="https://github.com/Thuvee416/Opusloops" \
      org.opencontainers.image.revision="${OPUSLOOPS_GIT_COMMIT}" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/opusloops/venv/bin:/opt/opusloops/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TORCH_HOME=/opt/opusloops/models/torch \
    OPUSLOOPS_SCRATCH_ROOT=/scratch

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        libgomp1 \
        libsndfile1 \
        passwd \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 opusloops \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin opusloops \
    && install -d -o 10001 -g 10001 -m 0700 /scratch

COPY --from=builder /opt/opusloops /opt/opusloops
COPY --chmod=0555 worker/entrypoint.sh /opt/opusloops/bin/opusloops-worker-entrypoint

USER 10001:10001
WORKDIR /scratch
ENTRYPOINT ["/opt/opusloops/bin/opusloops-worker-entrypoint"]
CMD ["--help"]
