import json
import os
import time
from collections.abc import Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import torch
from typing_extensions import override

from comfy.cli_args import args
from comfy_api.latest import IO, ComfyExtension
from comfy_api_nodes.apis.banana import (
    BananaGenerationRequest,
    BananaSubmitResponse,
    BananaTaskResponse,
    BananaBaseResponse,
)
from comfy_api_nodes.util import ApiEndpoint, download_url_to_image_tensor, poll_op, sync_op, validate_string
from comfy_api_nodes.util.conversions import tensor_to_data_uri

GENERATE_PATH = "/api/v2/image/nano_banana/generate"
TASKS_PATH = "/api/v2/image/nano_banana/tasks"
ASPECT_RATIOS = ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"]
RESOLUTIONS = ["auto", "1K", "2K", "4K"]
MAX_REFERENCE_IMAGES = 10


def _resolve_api_base() -> str:
    base = getattr(args, "minimax_design_api_base", None) or os.environ.get("MINIMAX_DESIGN_API_BASE")
    if not base:
        raise ValueError("Banana API is not configured. Set --minimax-design-api-base or MINIMAX_DESIGN_API_BASE.")
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
    params: dict[str, str] = {}
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


class _BananaNode(IO.ComfyNode):
    MODEL_NAME = ""
    DISPLAY_NAME = ""
    NODE_ID = ""
    AUTO_PRICE = 6
    PRICE_1K = 6
    PRICE_2K = 6
    PRICE_4K = 10

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id=cls.NODE_ID,
            display_name=cls.DISPLAY_NAME,
            category="partner/image",
            description=f"Generate images with {cls.DISPLAY_NAME} through the MiniMax Design API.",
            inputs=[
                IO.String.Input("prompt", multiline=True, default=""),
                IO.Combo.Input("resolution", options=RESOLUTIONS, default="auto"),
                IO.Combo.Input("aspect_ratio", options=ASPECT_RATIOS, default="auto"),
                IO.Autogrow.Input(
                    "reference_images",
                    optional=True,
                    template=IO.Autogrow.TemplateNames(
                        IO.Image.Input("reference_image"),
                        names=[f"image_{i}" for i in range(1, MAX_REFERENCE_IMAGES + 1)],
                        min=0,
                    ),
                ),
            ],
            outputs=[IO.Image.Output()],
            hidden=[IO.Hidden.unique_id],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                depends_on=IO.PriceBadgeDepends(widgets=["resolution"]),
                expr=f"""
                (
                  $resolution := $lookup(widgets, "resolution");
                  $price := $resolution = "1K" ? {cls.PRICE_1K} :
                             $resolution = "2K" ? {cls.PRICE_2K} :
                             $resolution = "4K" ? {cls.PRICE_4K} : {cls.AUTO_PRICE};
                  {{"type": "text", "text": $string($price) & " credits"}}
                )
                """,
            ),
        )

    @classmethod
    async def execute(
        cls,
        prompt: str,
        resolution="auto",
        aspect_ratio="auto",
        reference_images=None,
    ) -> IO.NodeOutput:
        validate_string(prompt, field_name="prompt", strip_whitespace=True, min_length=1)
        images = list(_iter_images(reference_images))
        if len(images) > MAX_REFERENCE_IMAGES:
            raise ValueError(f"{cls.DISPLAY_NAME} supports up to {MAX_REFERENCE_IMAGES} reference images.")
        if resolution not in RESOLUTIONS or aspect_ratio not in ASPECT_RATIOS:
            raise ValueError(f"Unsupported {cls.DISPLAY_NAME} resolution/aspect ratio: {resolution}/{aspect_ratio}")

        base = _resolve_api_base()
        headers = _resolve_auth_headers()
        submit = await sync_op(
            cls,
            ApiEndpoint(
                path=_with_common_params(f"{base}{GENERATE_PATH}"),
                method="POST",
                headers=headers,
            ),
            response_model=BananaSubmitResponse,
            data=BananaGenerationRequest(
                prompt=prompt.strip(),
                model_name=cls.MODEL_NAME,
                image_paths=[tensor_to_data_uri(image, mime_type="image/png") for image in images],
                aspect_ratio=aspect_ratio,
                resolution=resolution,
            ),
        )
        if not submit.task_id:
            base_resp: BananaBaseResponse | None = submit.base
            detail = (base_resp.user_message or base_resp.message) if base_resp else None
            raise Exception(f"{cls.DISPLAY_NAME} submit failed: {detail or 'missing task_id'}")

        result = await poll_op(
            cls,
            ApiEndpoint(
                path=_with_common_params(f"{base}{TASKS_PATH}/{submit.task_id}"),
                headers=headers,
            ),
            response_model=BananaTaskResponse,
            status_extractor=lambda response: response.status,
        )
        if not result.image_url:
            raise Exception(f"{cls.DISPLAY_NAME} returned no image URL: {result.model_dump()}")
        return IO.NodeOutput(await download_url_to_image_tensor(result.image_url))


class Banana2Node(_BananaNode):
    MODEL_NAME = "nano_banana_2_flash"
    DISPLAY_NAME = "Nano Banana 2"
    NODE_ID = "Banana2Node"
    AUTO_PRICE = 50
    PRICE_1K = 40
    PRICE_2K = 50
    PRICE_4K = 80


class BananaProNode(_BananaNode):
    MODEL_NAME = "nano_banana_2"
    DISPLAY_NAME = "Nano Banana Pro"
    NODE_ID = "BananaProNode"
    AUTO_PRICE = 60
    PRICE_1K = 60
    PRICE_2K = 60
    PRICE_4K = 100


class BananaExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [Banana2Node, BananaProNode]


async def comfy_entrypoint() -> BananaExtension:
    return BananaExtension()
