from types import SimpleNamespace

import pytest
import torch

from comfy_api_nodes import nodes_g_image_2
from comfy_api_nodes.apis.g_image_2 import GImage2SubmitResponse


def test_g_image_2_submit_accepts_numeric_gateway_status():
    response = GImage2SubmitResponse.model_validate({"task_id": "task-1", "status": 1})
    assert response.status == 1


@pytest.mark.asyncio
async def test_g_image_2_submits_design_gateway_request_and_returns_all_images(monkeypatch):
    submitted = []
    endpoints = []

    async def upload_image(cls, base, image, wait_label, headers=None):
        return f"https://cdn.example/{wait_label.rsplit(' ', 1)[-1]}.png"

    async def sync_op(cls, endpoint, response_model, data=None, **kwargs):
        endpoints.append(endpoint.path)
        submitted.append(data)
        return SimpleNamespace(task_id="task-1", base=None)

    async def poll_op(cls, endpoint, **kwargs):
        endpoints.append(endpoint.path)
        return SimpleNamespace(
            status="success",
            image_url="https://cdn.example/result-1.png",
            image_urls=[
                "https://cdn.example/result-1.png",
                "https://cdn.example/result-2.png",
            ],
            model_dump=lambda: {},
        )

    async def download(url):
        value = 0.25 if url.endswith("1.png") else 0.75
        return torch.full((1, 8, 8, 3), value)

    monkeypatch.setattr(nodes_g_image_2, "_resolve_api_base", lambda: "https://design.example")
    monkeypatch.setattr(nodes_g_image_2, "_resolve_auth_headers", lambda: {"token": "test"})
    monkeypatch.setattr(nodes_g_image_2, "_with_common_params", lambda url: url)
    monkeypatch.setattr(nodes_g_image_2, "_upload_image", upload_image)
    monkeypatch.setattr(nodes_g_image_2, "sync_op", sync_op)
    monkeypatch.setattr(nodes_g_image_2, "poll_op", poll_op)
    monkeypatch.setattr(nodes_g_image_2, "download_url_to_image_tensor", download)

    output = await nodes_g_image_2.GImage2Node.execute(
        prompt="  a glass sculpture  ",
        resolution="4k",
        aspect_ratio="16:9",
        quality="high",
        n=2,
        reference_images={
            "image_1": torch.zeros((1, 16, 16, 3)),
            "image_2": torch.ones((1, 16, 16, 3)),
        },
    )

    assert endpoints == [
        "https://design.example/api/v2/image/openai/generate",
        "https://design.example/api/v2/image/openai/tasks/task-1",
    ]
    assert submitted[0].model_dump() == {
        "prompt": "a glass sculpture",
        "model": "gpt-image-2",
        "size": "3840x2160",
        "image_paths": [
            "https://cdn.example/1.png",
            "https://cdn.example/2.png",
        ],
        "quality": "high",
        "n": 2,
    }
    assert output[0].shape == (2, 8, 8, 3)


@pytest.mark.parametrize(
    "resolution,aspect_ratio,size",
    [
        ("1k", "1:1", "1024x1024"),
        ("2k", "21:9", "3024x1296"),
        ("4k", "1:3", "1280x3840"),
    ],
)
def test_g_image_2_size_mapping_matches_gateway_contract(resolution, aspect_ratio, size):
    assert nodes_g_image_2.SIZE_MAP[resolution][aspect_ratio] == size


def test_g_image_2_has_independent_node_identity_and_category():
    schema = nodes_g_image_2.GImage2Node.define_schema()
    assert schema.node_id == "GImage2Node"
    assert schema.category == "partner/image"
    assert schema.price_badge is not None
