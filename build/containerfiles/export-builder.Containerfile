# Builder image for exporting Backstage dynamic plugins on the same RHEL/UBI ABI as RHDH.
# One image per Node major (ubi9-node22, ubi9-node24) with pre-installed rhdh-cli versions.
#
# Build args (set by publish-export-builder workflow):
#   NODE_MAJOR — 22 or 24
#   NODEJS_BASE_IMAGE — pinned ubi9/nodejs-N image reference
#
ARG NODE_MAJOR=24
ARG NODEJS_BASE_IMAGE=registry.access.redhat.com/ubi9/nodejs-24:1781010361@sha256:1938804c6eb623798504f7940bac7f09ca18766f62ce8b80353514a839e58426

FROM ${NODEJS_BASE_IMAGE}
ARG NODE_MAJOR=24
USER 0

# Native build deps; buildah/skopeo for OCI publish (compile job does not nest containers).
RUN dnf config-manager --set-enabled ubi-9-codeready-builder-rpms \
  && dnf install -y -q --allowerasing \
    gcc gcc-c++ make git patch jq \
    libjpeg-turbo-devel \
    python3 libstdc++-devel zlib-devel openssl-devel \
    buildah skopeo \
    util-linux \
  && dnf clean all \
  && npm install -g corepack \
  && corepack enable

COPY build/generated/ /tmp/export-builder-generated/
RUN cp "/tmp/export-builder-generated/cli-install-node${NODE_MAJOR}.sh" /tmp/cli-install.sh \
  && mkdir -p /etc/rhdh-export-builder \
  && cp "/tmp/export-builder-generated/export-builder-node${NODE_MAJOR}.json" /etc/rhdh-export-builder/manifest.json \
  && rm -rf /tmp/export-builder-generated
RUN chmod +x /tmp/cli-install.sh && /tmp/cli-install.sh && rm -f /tmp/cli-install.sh \
  && chown -R 1001:1001 /opt/rhdh-cli /opt/app-root/src/.npm 2>/dev/null || true

COPY build/containerfiles/entrypoint.sh /usr/local/bin/export-builder-entrypoint
RUN chmod +x /usr/local/bin/export-builder-entrypoint

LABEL summary="RHDH dynamic plugin export builder (UBI 9 Node ${NODE_MAJOR})" \
      description="UBI 9 Node.js ${NODE_MAJOR} environment for exporting Backstage plugins" \
      maintainer="RHDH Team <rhdh-bot@redhat.com>"

USER 1001
ENTRYPOINT ["/usr/local/bin/export-builder-entrypoint"]
