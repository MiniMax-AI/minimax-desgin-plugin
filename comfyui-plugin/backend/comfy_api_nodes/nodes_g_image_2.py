import json
import os
import time
from collections.abc import Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import torch
from typing_extensions import override

from comfy.cli_args import args
from comfy_api.latest import IO, ComfyExtension
from comfy_api_nodes.apis.g_image_2 import (
    DesignGatewayUploadRequest,
    DesignGatewayUploadResponse,
    GImage2GenerationRequest,
    GImage2SubmitResponse,
    GImage2TaskResponse,
    DesignGatewayBaseResponse,
)
from comfy_api_nodes.util import ApiEndpoint, download_url_to_image_tensor, poll_op, sync_op, validate_string
from comfy_api_nodes.util.conversions import tensor_to_data_uri

GENERATE_PATH = "/api/v2/image/openai/generate"
TASKS_PATH = "/api/v2/image/openai/tasks"
UPLOAD_PATH = "/api/v1/files/upload"

ASPECT_RATIOS = ["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "2:1", "1:2", "3:1", "1:3"]
SIZE_MAP = {
    "1k": {"1:1": "1024x1024", "16:9": "1280x720", "9:16": "720x1280", "3:4": "864x1152", "4:3": "1152x864", "3:2": "1248x832", "2:3": "832x1248", "5:4": "1120x896", "4:5": "896x1120", "21:9": "1344x576", "2:1": "1440x720", "1:2": "720x1440", "3:1": "1728x576", "1:3": "576x1728"},
    "2k": {"1:1": "2048x2048", "16:9": "2560x1440", "9:16": "1440x2560", "3:4": "1728x2304", "4:3": "2304x1728", "3:2": "2496x1664", "2:3": "1664x2496", "5:4": "2240x1792", "4:5": "1792x2240", "21:9": "3024x1296", "2:1": "2880x1440", "1:2": "1440x2880", "3:1": "3552x1184", "1:3": "1184x3552"},
    "4k": {"1:1": "2880x2880", "16:9": "3840x2160", "9:16": "2160x3840", "3:4": "2448x3264", "4:3": "3264x2448", "3:2": "3504x2336", "2:3": "2336x3504", "5:4": "3200x2560", "4:5": "2560x3200", "21:9": "3696x1584", "2:1": "3840x1920", "1:2": "1920x3840", "3:1": "3840x1280", "1:3": "1280x3840"},
}


def _resolve_api_base() -> str:
    base = getattr(args, "minimax_design_api_base", None) or os.environ.get("MINIMAX_DESIGN_API_BASE")
    if not base:
        raise ValueError("G Image 2 Design API is not configured. Set --minimax-design-api-base or MINIMAX_DESIGN_API_BASE.")
    return base.rstrip("/")


def _resolve_auth_headers() -> dict[str, str]:
    token = (os.environ.get("MINIMAX_DESIGN_API_TOKEN") or "").strip()
    if not token:
        token_file = (os.environ.get("MINIMAX_DESIGN_API_TOKEN_FILE") or "").strip()
        if not token_file and os.environ.get("HUB_PLUGIN_DATA_DIR"):
            token_file = os.path.join(os.environ["HUB_PLUGIN_DATA_DIR"], "design-api-token")
        if token_file and os.path.isfile(token_file):
            try:
                with open(token_file, encoding="utf-8") as f:
                    token = f.read().strip()
            except OSError:
                token = ""
    if not token:
        return {}
    headers = {"token": token, "Authorization": f"Bearer {token}"}
    group_id = (os.environ.get("MINIMAX_DESIGN_API_GROUP_ID") or "").strip()
    if group_id:
        headers["X-Group-Id"] = group_id
    return headers


def _with_common_params(url: str) -> str:
    params = {}
    raw = (os.environ.get("MINIMAX_DESIGN_COMMON_PARAMS") or "").strip()
    if raw:
        try:
            loaded = json.loads(raw)
        except ValueError:
            loaded = None
        if isinstance(loaded, dict):
            params = {str(k): str(v) for k, v in loaded.items()}
    params["unix"] = str(int(time.time() * 1000))
    scheme, netloc, path, query, fragment = urlsplit(url)
    merged = dict(parse_qsl(query, keep_blank_values=True))
    merged.update(params)
    return urlunsplit((scheme, netloc, path, urlencode(merged), fragment))


def _iter_images(images: dict | None) -> Iterator[torch.Tensor]:
    for tensor in (images or {}).values():
        if tensor is None:
            continue
        if len(tensor.shape) > 3:
            yield from (tensor[i] for i in range(tensor.shape[0]))
        else:
            yield tensor


async def _upload_image(
    cls, base: str, image: torch.Tensor, wait_label: str, headers: dict[str, str]
) -> str:
    response = await sync_op(
        cls,
        ApiEndpoint(path=_with_common_params(f"{base}{UPLOAD_PATH}"), method="POST", headers=headers),
        response_model=DesignGatewayUploadResponse,
        data=DesignGatewayUploadRequest(
            file_data=tensor_to_data_uri(image, mime_type="image/png")
        ),
        wait_label=wait_label,
        final_label_on_success=None,
    )
    return response.url


class GImage2Node(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="GImage2Node",
            display_name="GPT Image 2",
            category="partner/image",
            description="Generate or edit images with GPT Image 2 through the MiniMax Design API.",
            inputs=[
                IO.String.Input("prompt", multiline=True, default=""),
                IO.Combo.Input("resolution", options=["1k", "2k", "4k"], default="1k"),
                IO.Combo.Input("aspect_ratio", options=ASPECT_RATIOS, default="1:1"),
                IO.Combo.Input(
                    "quality", options=["low", "medium", "high"], default="medium"
                ),
                IO.Int.Input(
                    "n",
                    default=1,
                    min=1,
                    max=4,
                    step=1,
                    display_mode=IO.NumberDisplay.number,
                ),
                IO.Autogrow.Input(
                    "reference_images",
                    optional=True,
                    template=IO.Autogrow.TemplateNames(
                        IO.Image.Input("reference_image"),
                        names=[f"image_{i}" for i in range(1, 17)],
                        min=0,
                    ),
                ),
            ],
            outputs=[IO.Image.Output()],
            hidden=[IO.Hidden.unique_id],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                depends_on=IO.PriceBadgeDepends(
                    widgets=["resolution", "quality", "n"],
                    input_groups=["reference_images"],
                ),
                expr="""
                (
                  $prices := {
                    "low": {"1k": 20, "2k": 50, "4k": 100},
                    "medium": {"1k": 80, "2k": 200, "4k": 400},
                    "high": {"1k": 300, "2k": 800, "4k": 1600}
                  };
                  $resolution := $lookup(widgets, "resolution");
                  $quality := $lookup(widgets, "quality");
                  $nRaw := $lookup(widgets, "n");
                  $n := $nRaw ? $nRaw : 1;
                  $refsRaw := $lookup(inputGroups, "reference_images");
                  $refs := $refsRaw ? $refsRaw : 0;
                  $unit := $lookup($lookup($prices, $quality), $resolution);
                  {"type": "text", "text": $string($unit * $n + $refs * 10) & " credits"}
                )
                """,
            ),
        )

    @classmethod
    async def execute(
        cls,
        prompt: str,
        resolution="1k",
        aspect_ratio="1:1",
        quality="medium",
        n=1,
        reference_images=None,
    ) -> IO.NodeOutput:
        validate_string(prompt, field_name="prompt", strip_whitespace=True, min_length=1)
        images = list(_iter_images(reference_images))
        if len(images) > 16:
            raise ValueError("G Image 2 supports up to 16 reference images.")
        try:
            size = SIZE_MAP[resolution][aspect_ratio]
        except KeyError as e:
            raise ValueError(f"Unsupported G Image 2 resolution/aspect ratio: {resolution}/{aspect_ratio}") from e
        base = _resolve_api_base()
        headers = _resolve_auth_headers()
        image_paths = [
            await _upload_image(cls, base, image, f"Uploading reference image {i}", headers)
            for i, image in enumerate(images, 1)
        ]
        submit = await sync_op(
            cls,
            ApiEndpoint(
                path=_with_common_params(f"{base}{GENERATE_PATH}"),
                method="POST",
                headers=headers,
            ),
            response_model=GImage2SubmitResponse,
            data=GImage2GenerationRequest(
                prompt=prompt.strip(),
                size=size,
                image_paths=image_paths,
                quality=quality,
                n=n,
            ),
        )
        if not submit.task_id:
            base_resp: DesignGatewayBaseResponse | None = submit.base
            raise Exception(f"G Image 2 submit failed: {(base_resp.user_message or base_resp.message) if base_resp else 'missing task_id'}")
        result = await poll_op(
            cls,
            ApiEndpoint(
                path=_with_common_params(f"{base}{TASKS_PATH}/{submit.task_id}"),
                headers=headers,
            ),
            response_model=GImage2TaskResponse,
            status_extractor=lambda r: (
                r.status if r.image_url or r.image_urls or r.status != "success" else "processing"
            ),
        )
        urls = [url for url in result.image_urls if url] or ([result.image_url] if result.image_url else [])
        if not urls:
            raise Exception(f"G Image 2 returned no image URL: {result.model_dump()}")
        tensors = [await download_url_to_image_tensor(url) for url in urls]
        return IO.NodeOutput(torch.cat(tensors) if len(tensors) > 1 else tensors[0])


class GImage2Extension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [GImage2Node]


async def comfy_entrypoint() -> GImage2Extension:
    return GImage2Extension()
