# syntax=docker/dockerfile:1
# Agent controller: herdr over an unprivileged sshd, plus opencode/git/kubectl.
# Upstream opencode ships Alpine only (pinned by digest); herdr is static-pie.
FROM ghcr.io/anomalyco/opencode:2.1.2@sha256:d91c668b3390b5416fee4803ffd0936ad30c3e118f550e7ad6d2fabc8b974b00

USER root
RUN apk add --no-cache bash git openssh-client openssh-server ca-certificates \
      curl jq ripgrep procps kubectl ncurses-terminfo-base github-cli \
 && adduser -D -u 1000 -s /bin/bash opencode

# herdr 0.9.5, checksum from https://herdr.dev/latest.json
ADD --checksum=sha256:14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d \
    --chmod=755 \
    https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64 \
    /usr/local/bin/herdr

COPY sshd_config /etc/herdr/sshd_config
COPY --chmod=755 herdr-controller /usr/local/bin/herdr-controller
COPY --chmod=755 gh /usr/local/bin/gh
COPY opencode.json /opt/opencode-home/opencode.json
COPY plugin /opt/opencode-home/plugin/

USER 1000
WORKDIR /home/opencode
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/herdr-controller"]
