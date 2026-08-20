from types import SimpleNamespace

import pytest
import torch

from comfy_api_nodes import nodes_banana
from comfy_api_nodes.apis.banana import BananaSubmitResponse


def test_banana_submit_accepts_numeric_gateway_status():
    response = BananaSubmitResponse.model_validate({"task_id": "task-1", "status": 1})
    assert response.status == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("node_cls", "model_name"),
    [
        (nodes_banana.Banana2Node, "nano_banana_2_flash"),
        (nodes_banana.BananaProNode, "nano_banana_2"),
    ],
)
async def test_banana_submits_gateway_contract(monkeypatch, node_cls, model_name):
    requests = []
    endpoints = []

    async def sync_op(cls, endpoint, response_model, data=None, **kwargs):
        endpoints.append(endpoint.path)
        requests.append(data)
        return SimpleNamespace(task_id="task-1", base=None)

    async def poll_op(cls, endpoint, **kwargs):
        endpoints.append(endpoint.path)
        return SimpleNamespace(status="success", image_url="https://cdn.example/result.png", model_dump=lambda: {})

    async def download(url):
        return torch.zeros((1, 8, 8, 3))

    monkeypatch.setattr(nodes_banana, "_resolve_api_base", lambda: "https://cloud.example")
    monkeypatch.setattr(nodes_banana, "_resolve_auth_headers", lambda: {"token": "test"})
    monkeypatch.setattr(nodes_banana, "_with_common_params", lambda url: url)
    monkeypatch.setattr(nodes_banana, "sync_op", sync_op)
    monkeypatch.setattr(nodes_banana, "poll_op", poll_op)
    monkeypatch.setattr(nodes_banana, "download_url_to_image_tensor", download)

    output = await node_cls.execute(
        prompt=" cat ",
        resolution="2K",
        aspect_ratio="16:9",
        reference_images={"image_1": torch.ones((1, 4, 4, 3))},
    )

    assert endpoints == [
        "https://cloud.example/api/v2/image/nano_banana/generate",
        "https://cloud.example/api/v2/image/nano_banana/tasks/task-1",
    ]
    assert requests[0].model_dump() == {
        "prompt": "cat",
        "model_name": model_name,
        "image_paths": [requests[0].image_paths[0]],
        "aspect_ratio": "16:9",
        "resolution": "2K",
    }
    assert requests[0].image_paths[0].startswith("data:image/png;base64,")
    assert output[0].shape == (1, 8, 8, 3)


def test_banana_nodes_are_independent_partner_image_nodes():
    assert nodes_banana.Banana2Node.define_schema().category == "partner/image"
    assert nodes_banana.BananaProNode.define_schema().category == "partner/image"
