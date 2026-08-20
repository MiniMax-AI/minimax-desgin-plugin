from types import SimpleNamespace

import pytest
import torch

from comfy_api_nodes import nodes_minimax_h3


class FakeVideo:
    def __init__(self, width: int, height: int, duration: float = 5.25):
        self.width = width
        self.height = height
        self.duration = duration

    def get_dimensions(self):
        return self.width, self.height

    def get_duration(self):
        return self.duration


def test_h3_partner_nodes_are_directly_under_video_category():
    assert nodes_minimax_h3.MinimaxH3PromptExpandNode.define_schema().category == "partner/video"
    assert nodes_minimax_h3.MinimaxH3VideoEnhancementNode.define_schema().category == "partner/video"


@pytest.mark.parametrize("width,height", [(767, 768), (769, 1344)])
@pytest.mark.asyncio
async def test_h3_enhancement_rejects_video_outside_pixel_range(monkeypatch, width, height):
    async def unexpected_upload(*args, **kwargs):
        raise AssertionError("invalid video must be rejected before upload")

    monkeypatch.setattr(nodes_minimax_h3, "_upload_video", unexpected_upload)

    with pytest.raises(ValueError, match="requires between 768x768"):
        await nodes_minimax_h3.MinimaxH3VideoEnhancementNode.execute(
            video=FakeVideo(width, height),
            prompt="final prompt",
        )


@pytest.mark.asyncio
async def test_h3_enhancement_forwards_source_context(monkeypatch):
    source_video = FakeVideo(768, 1344)
    reference_video = FakeVideo(768, 768)
    submitted = []

    async def upload_video(cls, base, video, wait_label, headers=None):
        return f"https://cdn.example/{'source' if video is source_video else 'reference'}.mp4"

    async def upload_image(cls, base, image, wait_label, headers=None):
        return "https://cdn.example/reference.png"

    async def upload_audio(cls, base, audio, wait_label, headers=None):
        return "https://cdn.example/reference.mp3"

    async def sync_op(cls, endpoint, response_model, data=None, **kwargs):
        if data is not None:
            submitted.append(data)
            return SimpleNamespace(task_id="task-1", base_resp=None)
        return SimpleNamespace(
            file=SimpleNamespace(download_url="https://cdn.example/upscaled.mp4")
        )

    async def poll_op(*args, **kwargs):
        return SimpleNamespace(file_id="file-1", status="success", base_resp=None)

    async def download(url):
        return f"downloaded:{url}"

    monkeypatch.setattr(nodes_minimax_h3, "_resolve_api_base", lambda: "https://design.example")
    monkeypatch.setattr(nodes_minimax_h3, "_resolve_auth_headers", lambda: {"token": "test"})
    monkeypatch.setattr(nodes_minimax_h3, "_upload_video", upload_video)
    monkeypatch.setattr(nodes_minimax_h3, "_upload_image", upload_image)
    monkeypatch.setattr(nodes_minimax_h3, "_upload_audio", upload_audio)
    monkeypatch.setattr(nodes_minimax_h3, "sync_op", sync_op)
    monkeypatch.setattr(nodes_minimax_h3, "poll_op", poll_op)
    monkeypatch.setattr(nodes_minimax_h3, "download_url_to_video_output", download)

    output = await nodes_minimax_h3.MinimaxH3VideoEnhancementNode.execute(
        video=source_video,
        prompt="  final prompt  ",
        reference_images={"image_1": torch.zeros((1, 16, 16, 3))},
        reference_videos={"video_1": reference_video},
        reference_audios={"audio_1": object()},
    )

    assert output[0] == "downloaded:https://cdn.example/upscaled.mp4"
    assert len(submitted) == 1
    request = submitted[0].model_dump(exclude_none=True)
    assert request == {
        "resolution": "2K",
        "base_video": "https://cdn.example/source.mp4",
        "base_video_duration_ms": 5250,
        "prompt": "final prompt",
        "reference_images": ["https://cdn.example/reference.png"],
        "reference_videos": ["https://cdn.example/reference.mp4"],
        "reference_audios": ["https://cdn.example/reference.mp3"],
    }
