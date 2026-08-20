<template>
  <div class="flex size-full flex-col">
    <div
      class="flex items-center justify-between px-3 py-2 text-xs text-text-secondary"
    >
      <span>{{ panelLabel }}</span>
      <span>{{ resources.length }}</span>
    </div>

    <div v-if="isLoading" class="flex flex-1 items-center justify-center">
      <i
        class="icon-[lucide--loader] size-6 animate-spin text-text-secondary"
      />
    </div>
    <div
      v-else-if="resources.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-text-secondary"
    >
      <i
        :class="
          isWorkspace
            ? 'icon-[lucide--panels-top-left] size-8 opacity-40'
            : 'icon-[lucide--workflow] size-8 opacity-40'
        "
      />
      <span class="text-sm">{{ emptyLabel }}</span>
    </div>
    <template v-else>
      <div v-if="viewMode === 'list'" class="flex-1 overflow-y-auto">
        <div :style="listGridStyle">
          <div
            v-for="item in assetsWithKey"
            :key="item.key"
            class="group relative flex cursor-pointer items-center overflow-hidden rounded-lg p-2 transition-colors"
            :class="
              selectedKeys.has(resourceKey(item)) &&
              'bg-modal-card-background-hovered/20 ring-1 ring-modal-card-border-highlighted ring-inset'
            "
            @click="toggleSelection(item)"
            @contextmenu.prevent.stop="handleContextMenu($event, item)"
          >
            <AssetsListItem
              class="w-full"
              :preview-url="item.preview_url"
              :preview-alt="item.name"
              :icon-name="iconForMediaType(getMediaType(item))"
              :is-video-preview="getMediaType(item) === 'video'"
              :primary-text="item.name"
              :secondary-text="getSecondaryText(item)"
              @preview-click="handlePreview(item)"
            >
              <template #actions>
                <Button
                  variant="textonly"
                  size="icon"
                  :disabled="importingId === resourceKey(item)"
                  :aria-label="$t('g.upload')"
                  @click.stop="handleImport(item)"
                >
                  <i
                    v-if="importingId === resourceKey(item)"
                    class="icon-[lucide--loader] size-4 animate-spin"
                  />
                  <i v-else class="icon-[lucide--download] size-4" />
                </Button>
                <Button
                  variant="textonly"
                  size="icon"
                  :aria-label="$t('mediaAsset.actions.moreOptions')"
                  @click.stop="handleContextMenu($event, item)"
                >
                  <i class="icon-[lucide--ellipsis] size-4" />
                </Button>
              </template>
            </AssetsListItem>
          </div>
        </div>
      </div>

      <div v-else class="flex-1 overflow-y-auto">
        <div :style="gridStyle">
          <div
            v-for="item in assetsWithKey"
            :key="item.key"
            class="group relative"
          >
            <MediaAssetCard
              :asset="item"
              :selected="selectedKeys.has(resourceKey(item))"
              :show-output-count="false"
              @select="toggleSelection(item)"
              @toggle-selection="toggleSelection(item)"
              @zoom="handlePreview(item)"
              @context-menu="handleContextMenu($event, item)"
            />
            <Button
              variant="overlay-white"
              size="icon"
              :disabled="importingId === resourceKey(item)"
              class="absolute right-2 bottom-12 z-2 size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              :aria-label="$t('g.upload')"
              @click.stop="handleImport(item)"
            >
              <i
                v-if="importingId === resourceKey(item)"
                class="icon-[lucide--loader] size-4 animate-spin"
              />
              <i v-else class="icon-[lucide--download] size-4" />
            </Button>
          </div>
        </div>
      </div>
    </template>
  </div>

  <MediaLightbox
    v-model:active-index="galleryActiveIndex"
    :all-gallery-items="galleryItems"
  />

  <MediaAssetContextMenu
    v-if="contextAsset"
    ref="contextMenuRef"
    :asset="contextAsset"
    asset-type="input"
    :file-kind="contextFileKind"
    :show-delete-button="false"
    :show-workflow-actions="!isWorkspace"
    :selected-assets="selectedAssets"
    :is-bulk-mode="selectedAssets.length > 1"
    @zoom="handleContextPreview"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import Button from '@/components/ui/button/Button.vue'
import MediaLightbox from '@/components/sidebar/tabs/queue/MediaLightbox.vue'
import MediaAssetCard from '@/platform/assets/components/MediaAssetCard.vue'
import AssetsListItem from '@/platform/assets/components/AssetsListItem.vue'
import MediaAssetContextMenu from '@/platform/assets/components/MediaAssetContextMenu.vue'
import { getMediaAssetGridColumns } from '@/platform/assets/components/mediaAssetViewOptions'
import type {
  MediaAssetGridMode,
  MediaAssetViewMode
} from '@/platform/assets/components/mediaAssetViewOptions'
import type { AssetItem } from '@/platform/assets/schemas/assetSchema'
import { iconForMediaType } from '@/platform/assets/utils/mediaIconUtil'
import {
  getMediaTypeFromFilename,
  isPreviewableMediaType
} from '@/utils/formatUtil'
import { ResultItemImpl } from '@/stores/queueStore'
import {
  importIncomingResourceWithToast,
  startIncomingResourceSync,
  startWorkspaceResourceSync,
  importWorkspaceResourceWithToast,
  useIncomingResources,
  useWorkspaceResources
} from '@/services/incomingAssetService'
import type { IncomingResource } from '@/services/incomingAssetService'

const props = withDefaults(
  defineProps<{
    viewMode: MediaAssetViewMode
    source?: 'incoming' | 'workspace'
  }>(),
  { source: 'incoming' }
)
const emit = defineEmits<{ imported: [path: string] }>()

const { t } = useI18n()
const incoming = useIncomingResources()
const workspace = useWorkspaceResources()
const viewMode = computed(() => props.viewMode)
const isWorkspace = computed(() => props.source === 'workspace')
const resources = computed(() =>
  isWorkspace.value ? workspace.resources.value : incoming.resources.value
)
const isLoading = computed(() =>
  isWorkspace.value ? workspace.isLoading.value : incoming.isLoading.value
)
const panelLabel = computed(() =>
  isWorkspace.value
    ? t('sideToolbar.labels.designCanvas')
    : t('sideToolbar.labels.incoming')
)
const emptyLabel = computed(() =>
  isWorkspace.value
    ? t('sideToolbar.noDesignCanvasFiles')
    : t('sideToolbar.noIncomingFiles')
)

onMounted(() => {
  void (isWorkspace.value
    ? startWorkspaceResourceSync()
    : startIncomingResourceSync())
})

const importingId = ref<string | null>(null)
const selectedKeys = ref<Set<string>>(new Set())
const galleryActiveIndex = ref(-1)
const contextMenuRef = ref<InstanceType<typeof MediaAssetContextMenu>>()
const contextAsset = ref<AssetItem | null>(null)

const listGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  padding: '0 0.5rem',
  gap: '0.5rem'
}

const gridMode = computed<MediaAssetGridMode>(() =>
  viewMode.value === 'grid-small' ? 'grid-small' : 'grid'
)

const gridStyle = computed(() => ({
  display: 'grid',
  gridTemplateColumns: getMediaAssetGridColumns(gridMode.value),
  padding: '0 0.5rem',
  gap: '0.5rem'
}))

function toAsset(resource: IncomingResource): AssetItem {
  const userMetadata: Record<string, unknown> = {}
  if (resource.durationSec !== undefined) {
    userMetadata.duration = resource.durationSec
  }
  if (resource.width !== undefined && resource.height !== undefined) {
    userMetadata.width = resource.width
    userMetadata.height = resource.height
  }

  return {
    id: `${resource.nodeId}:${resource.assetId}`,
    name: resource.name,
    display_name: resource.name,
    size: resource.fileSize,
    tags: ['input'],
    preview_url: resource.url,
    thumbnail_url: resource.url,
    user_metadata: userMetadata
  }
}

const assets = computed(() => resources.value.map(toAsset))

const assetsWithKey = computed(() =>
  assets.value.map((asset) => ({ ...asset, key: resourceKey(asset) }))
)

const resourceByAssetId = computed(
  () =>
    new Map(
      resources.value.map((resource) => [
        `${resource.nodeId}:${resource.assetId}`,
        resource
      ])
    )
)

const selectedAssets = computed(() =>
  assets.value.filter((asset) => selectedKeys.value.has(resourceKey(asset)))
)

const galleryItems = computed(() =>
  resources.value
    .filter((resource) => isPreviewableMediaType(getMediaType(resource)))
    .map((resource) => {
      const mediaType = getMediaType(resource)
      const item = new ResultItemImpl({
        filename: resource.name,
        subfolder: '',
        type: 'input',
        nodeId: '0',
        mediaType: mediaType === 'image' ? 'images' : mediaType
      })
      Object.defineProperty(item, 'url', {
        configurable: true,
        get: () => resource.url
      })
      return item
    })
)

const contextFileKind = computed(() =>
  contextAsset.value
    ? getMediaTypeFromFilename(contextAsset.value.name)
    : 'other'
)

function resourceKey(asset: AssetItem): string {
  return `${asset.id}:${asset.name}`
}

function getResource(asset: AssetItem): IncomingResource | undefined {
  return resourceByAssetId.value.get(asset.id)
}

function handleContextPreview() {
  if (contextAsset.value) handlePreview(contextAsset.value)
}

function getMediaType(resource: IncomingResource | AssetItem) {
  return getMediaTypeFromFilename(resource.name)
}

function getSecondaryText(asset: AssetItem): string {
  const resource = getResource(asset)
  return resource?.type.toUpperCase() ?? ''
}

function toggleSelection(asset: AssetItem) {
  const key = resourceKey(asset)
  const next = new Set(selectedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedKeys.value = next
}

function handlePreview(asset: AssetItem) {
  const resource = getResource(asset)
  if (!resource) return
  const index = resources.value
    .filter((item) => isPreviewableMediaType(getMediaType(item)))
    .findIndex((item) => item.assetId === resource.assetId)
  if (index !== -1) galleryActiveIndex.value = index
}

function handleContextMenu(event: MouseEvent, asset: AssetItem) {
  const resource = getResource(asset)
  if (!resource) return
  contextAsset.value = asset
  void nextTick(() => contextMenuRef.value?.show(event))
}

async function handleImport(asset: AssetItem) {
  const resource = getResource(asset)
  if (!resource) return
  const id = `${resource.nodeId}:${resource.assetId}`
  importingId.value = id
  try {
    const path = await (isWorkspace.value
      ? importWorkspaceResourceWithToast(resource)
      : importIncomingResourceWithToast(resource))
    if (path) emit('imported', path)
  } finally {
    if (importingId.value === id) importingId.value = null
  }
}
</script>
