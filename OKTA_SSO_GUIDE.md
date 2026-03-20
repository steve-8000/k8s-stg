# Okta SSO Guide

This repo is now wired so `Grafana` and `Argo CD` can use Okta once the Okta apps and Kubernetes secrets are created.

Argo CD uses direct OIDC in `argocd-config/argocd-cm.yaml`, not Dex.

## Endpoints

- Grafana: `https://grafana.clab.one`
- Argo CD UI: `https://argocd.clab.one`
- Argo CD CLI callback: `http://localhost:8085/auth/callback`

## 1. Create Okta applications

### Grafana

Create an Okta `OIDC - OpenID Connect` application with type `Web Application`.

- Sign-in redirect URI: `https://grafana.clab.one/login/okta`
- Sign-out redirect URI: `https://grafana.clab.one/logout`
- Grant types: `Authorization Code`, `Refresh Token`
- Scopes: `openid`, `profile`, `email`, `groups`, `offline_access`

Add a groups claim that includes the Grafana access groups you plan to use, for example:

- `grafana-admins`
- `grafana-editors`
- `grafana-viewers`

### Argo CD UI

Create an Okta `OIDC - OpenID Connect` application with type `Web Application`.

- Sign-in redirect URI: `https://argocd.clab.one/auth/callback`
- Sign-out redirect URI: `https://argocd.clab.one`
- Grant types: `Authorization Code`, `Refresh Token`
- Scopes: `openid`, `profile`, `email`, `groups`

### Argo CD CLI

Create a second Okta `OIDC - OpenID Connect` application with type `Single-Page Application`.

- Sign-in redirect URI: `http://localhost:8085/auth/callback`
- Sign-out redirect URI: `http://localhost:8085`
- Grant type: `Authorization Code`

## 2. Use an Okta authorization server with groups

For Argo CD, configure an authorization server that issues a `groups` claim.

- Issuer format: `https://<your-okta-domain>/oauth2/<auth-server-id>`
- Add a `groups` scope if your Okta setup requires it
- Ensure the `groups` claim is returned for the users allowed to access Grafana and Argo CD

## 3. Create Kubernetes secrets

### Grafana secret

The Grafana Helm values load an optional secret named `grafana-okta-auth`. Create it in the `monitoring` namespace.

```bash
kubectl create secret generic grafana-okta-auth \
  -n monitoring \
  --from-literal=GF_AUTH_OKTA_ENABLED=true \
  --from-literal=GF_AUTH_OKTA_NAME=Okta \
  --from-literal=GF_AUTH_OKTA_ALLOW_SIGN_UP=true \
  --from-literal=GF_AUTH_OKTA_AUTO_LOGIN=false \
  --from-literal=GF_AUTH_OKTA_USE_PKCE=true \
  --from-literal=GF_AUTH_OKTA_USE_REFRESH_TOKEN=true \
  --from-literal=GF_AUTH_OKTA_SCOPES="openid profile email groups offline_access" \
  --from-literal=GF_AUTH_OKTA_AUTH_URL="https://<your-okta-domain>/oauth2/<auth-server-id>/v1/authorize" \
  --from-literal=GF_AUTH_OKTA_TOKEN_URL="https://<your-okta-domain>/oauth2/<auth-server-id>/v1/token" \
  --from-literal=GF_AUTH_OKTA_API_URL="https://<your-okta-domain>/oauth2/<auth-server-id>/v1/userinfo" \
  --from-literal=GF_AUTH_OKTA_CLIENT_ID="<grafana-client-id>" \
  --from-literal=GF_AUTH_OKTA_CLIENT_SECRET="<grafana-client-secret>" \
  --from-literal=GF_AUTH_OKTA_ALLOWED_GROUPS="grafana-admins,grafana-editors,grafana-viewers" \
  --from-literal=GF_AUTH_OKTA_ROLE_ATTRIBUTE_PATH="contains(groups[*], 'grafana-admins') && 'Admin' || contains(groups[*], 'grafana-editors') && 'Editor' || 'Viewer'"
```

### Argo CD secret

Argo CD uses secret references from `argocd-cm`. Create a secret named `argocd-okta-oidc` in the `argocd` namespace and label it so Argo CD can read it.

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: argocd-okta-oidc
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
type: Opaque
stringData:
  issuer: https://<your-okta-domain>/oauth2/<auth-server-id>
  clientID: <argocd-ui-client-id>
  clientSecret: <argocd-ui-client-secret>
  cliClientID: <argocd-cli-client-id>
  logoutURL: https://<your-okta-domain>/oauth2/<auth-server-id>/v1/logout?id_token_hint={{token}}&post_logout_redirect_uri={{logoutRedirectURL}}
EOF
```

## 4. Group mapping defaults

This repo now maps these Argo CD groups by default:

- `argocd-admins` -> `role:admin`
- `argocd-readonly` -> `role:readonly`

Users without one of those mapped groups can still complete OIDC login, but they will not see Argo CD resources because `policy.default` is empty.

If you need different group names, update `argocd-config/argocd-rbac-cm.yaml`.

Grafana defaults are documented in the secret example above:

- `grafana-admins` -> `Admin`
- `grafana-editors` -> `Editor`
- only users in `GF_AUTH_OKTA_ALLOWED_GROUPS` can log in

## 5. Sync and verify

After the secrets exist, let Argo CD sync this repo and verify:

```bash
argocd app sync monitoring
argocd app sync root
kubectl rollout status deploy/monitoring-grafana -n monitoring
kubectl rollout status deploy/argocd-server -n argocd
```

Then verify:

- Grafana shows an `Okta` login option at `https://grafana.clab.one/login`
- Argo CD shows an `Okta` login option at `https://argocd.clab.one`
- Users in `argocd-admins` get admin access
- Users in `argocd-readonly` get read-only access

## 6. Notes

- `clientSecret` values stay out of Git and must be created in-cluster.
- `argocd-cm` sets `url: https://argocd.clab.one`; redirect URIs must match exactly.
- The ingress manifests now increase proxy buffer size to reduce header issues when tokens or group claims are large.
