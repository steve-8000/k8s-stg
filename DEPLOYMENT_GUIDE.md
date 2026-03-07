# K8s STG — 애플리케이션 배포 가이드

> 이 문서는 AI 에이전트가 새로운 애플리케이션을 이 클러스터에 배포할 때 참조하는 안내서입니다.

---

## 1. 시스템 개요

| 항목 | 값 |
|---|---|
| Git 저장소 | `https://github.com/steve-8000/k8s-stg.git` (branch: `main`) |
| 로컬 경로 | `/Users/steve/k8s-stg` |
| 클러스터 | K3s v1.34.5 (single node, containerd) |
| 서버 | `root@219.255.103.189` (Ubuntu 24.04) |
| GitOps 엔진 | ArgoCD (https://argocd.clab.one) |
| 인증서 | cert-manager + Let's Encrypt (ClusterIssuer: `letsencrypt-prod`) |
| Ingress | nginx ingress controller (hostPort 80/443) |
| 모니터링 | Prometheus + Grafana (https://grafana.clab.one) |
| DNS 도메인 | `*.clab.one` → `219.255.103.189` |

---

## 2. 디렉토리 구조

```
k8s-stg/
├── bootstrap/                    # 클러스터 초기 부트스트랩 (건드리지 않음)
│   └── root.yaml
│
├── argocd-config/                # ArgoCD 메타 설정 (Projects, Apps, ApplicationSets)
│   ├── platform-project.yaml     # platform 프로젝트 RBAC
│   ├── workloads-project.yaml    # workloads 프로젝트 RBAC
│   ├── ingress-nginx.yaml        # App: ingress-nginx (sync-wave: -3)
│   ├── cert-manager.yaml         # App: cert-manager (sync-wave: -3)
│   ├── cert-manager-resources.yaml  # App: ClusterIssuer (sync-wave: -2)
│   ├── monitoring.yaml           # App: prometheus+grafana (sync-wave: -1)
│   ├── argocd-ingress.yaml       # App: ArgoCD ingress (sync-wave: -1)
│   └── workloads-appset.yaml     # ApplicationSet: workloads/* 자동 감지
│
├── platform/                     # 인프라 서비스 (Helm wrapper charts)
│   ├── ingress-nginx/
│   ├── cert-manager/
│   ├── cert-manager-resources/
│   ├── monitoring/
│   └── argocd-ingress/
│
└── workloads/                    # ★ 애플리케이션은 여기에 배포
    ├── nginx/                    # 예시 워크로드 1
    └── sample-app/               # 예시 워크로드 2
```

---

## 3. 워크로드 배포 방법 (핵심)

### 자동 감지 원리

`argocd-config/workloads-appset.yaml`에 정의된 **ApplicationSet**이 `workloads/*` 디렉토리를 자동으로 스캔합니다. 새 디렉토리를 만들고 `git push`하면 ArgoCD가 자동으로 Application을 생성하고 배포합니다.

- 디렉토리 이름 = ArgoCD Application 이름 = Kubernetes Namespace 이름
- 별도의 ArgoCD Application YAML을 작성할 필요 없음

### 3-1. 필수 파일 구조

`workloads/<app-name>/` 디렉토리 안에 다음 파일들을 생성합니다:

```
workloads/<app-name>/
├── kustomization.yaml      # 필수: 리소스 목록
├── namespace.yaml           # 필수: 네임스페이스 정의
├── deployment.yaml          # 필수: Deployment
├── service.yaml             # 필수: Service (ClusterIP)
└── ingress.yaml             # 선택: 외부 도메인 노출 시
```

### 3-2. 각 파일 템플릿

#### kustomization.yaml

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - deployment.yaml
  - service.yaml
  # - ingress.yaml          # 외부 노출이 필요한 경우 추가
```

#### namespace.yaml

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: <app-name>           # 디렉토리 이름과 반드시 동일
  labels:
    app.kubernetes.io/part-of: workloads
```

#### deployment.yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <app-name>
  namespace: <app-name>       # 디렉토리 이름과 동일
  labels:
    app.kubernetes.io/name: <app-name>
    app.kubernetes.io/instance: <app-name>-stg
spec:
  replicas: 1                 # 필요에 따라 조정
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: <app-name>
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app.kubernetes.io/name: <app-name>
        app.kubernetes.io/instance: <app-name>-stg
    spec:
      containers:
        - name: <app-name>
          image: <image>:<tag>
          ports:
            - name: http
              containerPort: <port>
              protocol: TCP
          readinessProbe:          # 필수
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:           # 필수
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:               # 필수
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
```

#### service.yaml

```yaml
apiVersion: v1
kind: Service
metadata:
  name: <app-name>
  namespace: <app-name>
  labels:
    app.kubernetes.io/name: <app-name>
spec:
  type: ClusterIP              # 항상 ClusterIP, NodePort 사용 금지
  selector:
    app.kubernetes.io/name: <app-name>
  ports:
    - name: http
      port: 80
      targetPort: http
      protocol: TCP
```

#### ingress.yaml (외부 도메인 노출 시)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: <app-name>-ingress
  namespace: <app-name>
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - <app-name>.clab.one
      secretName: <app-name>-tls
  rules:
    - host: <app-name>.clab.one
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: <app-name>
                port:
                  number: 80
```

> Ingress를 추가하는 경우 DNS A 레코드(`<app-name>.clab.one → 219.255.103.189`)가 사전에 등록되어 있어야 합니다.

### 3-3. 배포 실행

```bash
cd /Users/steve/k8s-stg
# 1. 파일 생성 (위 템플릿 기반)
# 2. Git commit & push
git add workloads/<app-name>/
git commit -m "Deploy <app-name>"
git push origin main
# 3. 끝. ArgoCD가 자동으로 감지하여 배포 (약 1~3분)
```

---

## 4. 규칙 및 제약사항

### 반드시 지켜야 할 것

| 규칙 | 이유 |
|---|---|
| 디렉토리 이름 = namespace 이름 | ApplicationSet이 디렉토리명을 namespace로 사용 |
| Service type은 `ClusterIP` | 외부 노출은 반드시 Ingress를 통해 |
| `resources.requests/limits` 필수 | 리소스 관리 및 스케줄링 안정성 |
| `readinessProbe` + `livenessProbe` 필수 | 무중단 배포 및 자동 복구 |
| 이미지 태그 고정 (`:latest` 금지) | 재현 가능한 배포 보장 |
| `labels`에 `app.kubernetes.io/name` 사용 | 표준 라벨링 컨벤션 |
| `revisionHistoryLimit: 3` 설정 | ReplicaSet 누적 방지 |
| `maxUnavailable: 0` | 배포 중 다운타임 방지 |
| `allowPrivilegeEscalation: false` | 보안 강화 |

### 하지 말아야 할 것

| 금지 항목 | 이유 |
|---|---|
| `workloads/` 외 경로에 워크로드 배포 | ApplicationSet이 감지하지 못함 |
| `argocd-config/`에 개별 Application YAML 수동 추가 | ApplicationSet이 자동 관리 |
| `platform/` 디렉토리 수정 | 인프라 서비스 영역, SRE만 변경 |
| `bootstrap/root.yaml` 수정 | 클러스터 루트 앱, 변경 금지 |
| `kubectl apply` 직접 실행 | 모든 변경은 Git을 통해서만 |
| NodePort 사용 | Ingress 표준 경로로 대체 |

---

## 5. 참고: 플랫폼 서비스 추가/변경 (SRE용)

인프라 레벨 서비스(Helm chart 기반)를 추가해야 하는 경우:

1. `platform/<service-name>/Chart.yaml` 생성 (Helm wrapper chart, 버전 고정)
2. `platform/<service-name>/values.yaml` 생성
3. `argocd-config/<service-name>.yaml`에 Application 매니페스트 추가 (project: `platform`)
4. 적절한 `sync-wave` 어노테이션 설정

```yaml
# argocd-config/<service-name>.yaml 예시
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: <service-name>
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "-1"    # 순서 조정
spec:
  project: platform
  source:
    repoURL: https://github.com/steve-8000/k8s-stg.git
    targetRevision: main
    path: platform/<service-name>
  destination:
    server: https://kubernetes.default.svc
    namespace: <target-namespace>
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 10s
        factor: 2
        maxDuration: 3m
```

---

## 6. 배포 후 확인

SSH 접속 후 다음 명령으로 확인할 수 있습니다:

```bash
ssh root@219.255.103.189

# 전체 ArgoCD 앱 상태
kubectl get apps -n argocd

# 특정 앱 상태
argocd app get <app-name> --plaintext

# Pod 상태
kubectl get pods -n <app-name>

# 로그 확인
kubectl logs -n <app-name> deployment/<app-name>
```

또는 ArgoCD UI에서 확인: https://argocd.clab.one

---

## 7. 워크로드 삭제

```bash
cd /Users/steve/k8s-stg
rm -rf workloads/<app-name>/
git add -A && git commit -m "Remove <app-name>" && git push
# ArgoCD가 자동으로 Application과 모든 리소스를 정리 (prune: true)
```
