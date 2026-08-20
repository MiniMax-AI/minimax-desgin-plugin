import {
  createRouter,
  createWebHashHistory,
  createWebHistory
} from 'vue-router'

import { hubBackendOrigin } from '@/hub/backend-origin'
import { isCloud, isDesktop } from '@/platform/distribution/types'
import { useTelemetry } from '@/platform/telemetry'
import { useUserStore } from '@/stores/userStore'
import LayoutDefault from '@/views/layouts/LayoutDefault.vue'

import { installPreservedQueryTracker } from '@/platform/navigation/preservedQueryTracker'
import { PRESERVED_QUERY_NAMESPACES } from '@/platform/navigation/preservedQueryNamespaces'

const isFileProtocol = window.location.protocol === 'file:'

/**
 * Hub 画布插件模式（gateway iframe，bootstrap 已写入后端 origin）。
 * 此时文档路径是 …/api/plugins/comfyui/static/index.html，若用
 * createWebHistory(basePath)，路由 '/' 的 base 归一化会把地址
 * replaceState 成 …/index.html/（尾斜杠）；之后任何 reload 都会让
 * 全部相对资源解析到 index.html/ “目录”下而 404，页面永远停在
 * 内联 splash。改用 hash 模式（与桌面版 file:// 同款）永不改写
 * pathname。
 */
const isHubPlugin = hubBackendOrigin() !== null

/**
 * Determine base path for the router.
 * - Electron: always root
 * - Cloud: use Vite's BASE_URL (configured at build time)
 * - Standard web (including reverse proxy subpaths): use window.location.pathname
 *   to support deployments like http://mysite.com/ComfyUI/
 */
function getBasePath(): string {
  if (isDesktop) return '/'
  if (isCloud) return import.meta.env?.BASE_URL || '/'
  return window.location.pathname
}

const basePath = getBasePath()

function trackPageView(): void {
  useTelemetry()?.trackPageView(document.title, {
    path: window.location.href
  })
}

const router = createRouter({
  history:
    isFileProtocol || isHubPlugin
      ? createWebHashHistory()
      : // Base path must be specified to ensure correct relative paths
        // Example: For URL 'http://localhost:7801/ComfyBackendDirect',
        // we need this base path or assets will incorrectly resolve from 'http://localhost:7801/'
        createWebHistory(basePath),
  routes: [
    {
      path: '/',
      component: LayoutDefault,
      children: [
        {
          path: '',
          name: 'GraphView',
          component: () => import('@/views/GraphView.vue'),
          beforeEnter: async (_to, _from, next) => {
            // Then check user store
            const userStore = useUserStore()
            await userStore.initialize()
            if (userStore.needsLogin) {
              next('/user-select')
            } else {
              next()
            }
          }
        },
        {
          path: 'user-select',
          name: 'UserSelectView',
          component: () => import('@/views/UserSelectView.vue')
        }
      ]
    }
  ],

  scrollBehavior(_to, _from, savedPosition) {
    if (savedPosition) {
      return savedPosition
    } else {
      return { top: 0 }
    }
  }
})

installPreservedQueryTracker(router, [
  {
    namespace: PRESERVED_QUERY_NAMESPACES.TEMPLATE,
    keys: ['template', 'source', 'mode']
  },
])

router.afterEach(() => {
  trackPageView()
})


export default router
