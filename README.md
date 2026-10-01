# Model Port

A custom workshop portal for external MaaS users: company sign-in, model discovery, endpoint/model/key connection details, copyable curl example, playground, and API-key revocation.

## Run locally

Requires Node.js 22 or later. No runtime packages or build step are required.

```bash
cd /Users/ckavili/RedHat/Tech/unboxing/week4/portal
PORT=3100 npm start
```

Open **http://localhost:3100**. Use **Sign in with your company account** and the workshop account supplied separately. No credentials are embedded in the app.

The supplied Keycloak client already permits localhost redirects and authorization code with PKCE. No cluster changes were needed. The portal uses authorization code with PKCE, not the password grant used in the first exercise.

## How it works

- The server exchanges the authorization code for tokens and confirms identity through Keycloak's userinfo endpoint.
- An HttpOnly, SameSite cookie identifies an in-memory server session. OIDC access and refresh tokens never go to the frontend. Access tokens are refreshed when needed.
- MaaS management calls use the signed-in user's access token. MaaS determines entitlements.
- Created MaaS key secrets are shown once to the user and held in server session memory for the playground. Inference uses that MaaS key, never admin credentials.
- Secrets are not stored in browser local storage or written to disk. Reloading clears the UI's copy of newly created keys; create another key to use the playground after reload. Existing key metadata remains available under My API keys.
- Signing out ends the local portal session. It does not end Keycloak SSO or revoke independently usable MaaS keys; revoke those under My API keys.

## Configuration

Environment variables:

| Variable | Default |
|---|---|
| `PORT` | `3000` (use `3100` here; 3000 was occupied) |
| `HOST` | `127.0.0.1` locally; `0.0.0.0` in the container |
| `APP_ORIGIN` | `http://localhost:<PORT>` |
| `OIDC_ISSUER` | Workshop Keycloak URL ending in `/realms/maas` |
| `OIDC_CLIENT_ID` | `maas-oidc` |
| `MAAS_URL` | Workshop MaaS gateway URL, without `/v1` |

Use the exact configured origin in the browser. The server binds to loopback by default; the container sets `HOST=0.0.0.0`. Meeting attendees should use the shared OpenShift URL below, rather than your laptop’s localhost. Multiple replicas require a shared session store. In-memory sessions and keys disappear on server restart; MaaS keys themselves remain valid until revoked or expired.

## Validation

```bash
npm test
```

Five automated checks cover unauthenticated access, request-origin protection, PKCE parameters, forged callback rejection, and frontend credential exposure.

A real headless Chrome test on 27 September 2026 verified:

1. Keycloak browser login as the workshop user.
2. Discovery of four models and selection of Granite.
3. Creation of a one-hour key for `oidc-ml-engineers`.
4. Playground inference: “The capital of Finland is Helsinki.”
5. Listing keys, revoking the created test key, and signing out.
6. No horizontal overflow at a 390px mobile viewport.

The test key was revoked. `preview.png` shows the tested interface with the secret masked before capture. Inference was tested on Granite only. The existing 1,000-token/hour model limits still apply; this portal does not change entitlements or quotas.

## OpenShift deployment

Deployed in namespace **maas-model-portal**:

https://model-portal-maas-model-portal.apps.cluster-6hk7k.6hk7k.sandbox3854.opentlc.com

Resources are in `deploy/openshift.yaml`; the image is built with the included `Dockerfile` using OpenShift's binary Docker build. The pod runs under the default restricted security policy, with no service-account token mounted, no elevated privileges, and a read-only root filesystem. HTTPS terminates at the OpenShift router; HTTP redirects to HTTPS. Session cookies use `Secure` on this route.

The exact callback below was added to the existing `maas-oidc` Keycloak client, preserving its other settings:

```text
https://model-portal-maas-model-portal.apps.cluster-6hk7k.6hk7k.sandbox3854.opentlc.com/auth/callback
```

Redeploy from the `portal` directory:

```bash
oc apply -f deploy/openshift.yaml
oc start-build model-portal -n maas-model-portal --from-dir=. --follow --wait
oc rollout restart deployment/model-portal -n maas-model-portal
oc rollout status deployment/model-portal -n maas-model-portal
```

This demo deliberately runs **one replica**, with `Recreate` deployments, because sessions are in memory. A restart or update signs users out and clears playground keys from session memory. The generated MaaS keys continue to exist until revoked or expired. Use a persistent shared session store before scaling beyond one replica.

The deployed HTTPS route was also verified in Chrome on 27 September 2026: sign-in as `maas-user`, model discovery, a one-hour key for `oidc-data-scientists`, a successful Granite response, key revocation, mobile layout, and sign-out. The deployment test key was revoked; other users' existing keys were left untouched. `deployed-preview.png` captures the deployed interface with the secret masked.

## Keycloak restart recovery (28 September 2026)

After a cluster restart, `/realms/maas` returned `Realm does not exist`. The original PostgreSQL deployment had no volume mounted, so its database was ephemeral.

Recovery completed:

- Backed up the remaining database, paused Keycloak, and migrated/restored the database to the 5Gi `keycloak-postgresql-data` PVC (`gp3-csi`).
- Mounted the PVC at `/var/lib/pgsql/data` and changed the database deployment strategy to `Recreate`.
- Resumed Keycloak and restored the missing realm from the existing `KeycloakRealmImport` configuration, including workshop users and groups.
- Added the deployed portal callback to both the live client and the cluster's realm import resource.
- Verified browser sign-in, model discovery, key creation, Granite inference, test-key revocation, and sign-out. Other users' keys were left untouched.

The storage manifests are `deploy/keycloak-persistence.yaml` and `deploy/keycloak-postgresql-patch.json`. The original guide repository was not modified; if its PostgreSQL deployment is reapplied, retain/reapply the persistent volume configuration. The PVC protects against pod/cluster restarts, not namespace deletion. Database backup during recovery was kept in an owner-only temporary file, outside the source directory.

## AI Engineers workshop subscription (30 September 2026)

Created `models-as-a-service/oidc-ai-engineers` with display name **OIDC AI Engineers**, copied model references and 1,000-token/hour limits from `oidc-data-scientists`, and preserved its `data-scientists` group membership rule so existing workshop identities can access it. Priority 31 makes it preferred over the old priority-30 subscription for those users. The old subscription remains for existing keys; both are visible to eligible users. The portal discovers the new subscription automatically. Declarative resource: `deploy/oidc-ai-engineers.json`.

The old `oidc-data-scientists` subscription was subsequently removed at the user's request on 30 September 2026. Its active `unboxing-day` key needs replacing with an `oidc-ai-engineers` key. The `data-scientists` Keycloak group and matching authorization policies remain because the new subscription still uses that group for access. Re-running the original guide's OIDC setup can recreate the old subscription.
