"""
WebRTC Signaling Server for OakTable

Signaling flow:
  1. Client A creates an SDP offer -> sends to server via WebSocket
  2. Server broadcasts the offer to all OTHER peers in the same room
  3. Client B receives the offer, creates an SDP answer -> sends back to server
  4. Server broadcasts the answer to Client A
  5. Both clients exchange ICE candidates through the same WebSocket channel

The server does NOT participate in P2P data/media transfer — it only relays
signaling payloads to help WebRTC peers establish direct connections.
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Dict, Set
import asyncio
import uuid

router = APIRouter()


class RoomManager:
    """Manages WebSocket connections for each signaling room."""

    # room_id -> set of active WebSocket connections
    _rooms: Dict[str, Set[WebSocket]] = {}

    @classmethod
    async def join_room(cls, room_id: str, websocket: WebSocket) -> None:
        """Add a websocket to a room, creating the room if necessary."""
        await websocket.accept()
        if room_id not in cls._rooms:
            cls._rooms[room_id] = set()
        cls._rooms[room_id].add(websocket)

    @classmethod
    async def leave_room(cls, room_id: str, websocket: WebSocket) -> None:
        """Remove a websocket from a room. Delete room if empty."""
        if room_id in cls._rooms:
            cls._rooms[room_id].discard(websocket)
            if not cls._rooms[room_id]:
                del cls._rooms[room_id]

    @classmethod
    async def broadcast(
        cls, room_id: str, message: dict, exclude: WebSocket | None = None
    ) -> None:
        """Broadcast a message to all peers in a room, optionally excluding one."""
        if room_id not in cls._rooms:
            return
        disconnected: Set[WebSocket] = set()
        for ws in cls._rooms[room_id]:
            if ws is exclude:
                continue
            try:
                await ws.send_json(message)
            except (WebSocketDisconnect, RuntimeError):
                disconnected.add(ws)
        # Clean up any dead connections found during broadcast
        for ws in disconnected:
            await cls.leave_room(room_id, ws)

    @classmethod
    def room_size(cls, room_id: str) -> int:
        """Return the number of peers currently in a room."""
        return len(cls._rooms.get(room_id, set()))


@router.websocket("/ws/signal/{room_id}/{peer_id}")
async def signaling_endpoint(websocket: WebSocket, room_id: str, peer_id: str) -> None:
    """
    WebSocket endpoint for WebRTC signaling.

    Each client connects with a unique room_id and peer_id.
    Messages received are broadcast to all other peers in the same room.

    Expected message format (JSON):
        {
            "type": "offer" | "answer" | "ice-candidate" | "chat",
            "from": "<peer_id>",
            "to": "<peer_id>",          // optional, null = broadcast
            "payload": <SDP or ICE data>
        }
    """
    await RoomManager.join_room(room_id, websocket)

    # Announce new peer joined (optional metadata)
    join_message = {
        "type": "peer-joined",
        "peer_id": peer_id,
        "room_size": RoomManager.room_size(room_id),
    }
    await RoomManager.broadcast(room_id, join_message, exclude=websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = __import__("json").loads(raw)
            except Exception:
                # Skip malformed JSON
                continue

            # Wrap in standard envelope if the client sent a bare payload
            if "type" not in message:
                message = {"type": "signal", "from": peer_id, "payload": message}
            else:
                message.setdefault("from", peer_id)

            # Relay to other peers in the room
            await RoomManager.broadcast(room_id, message, exclude=websocket)

    except WebSocketDisconnect:
        pass
    finally:
        leave_message = {
            "type": "peer-left",
            "peer_id": peer_id,
            "room_size": RoomManager.room_size(room_id),
        }
        await RoomManager.broadcast(room_id, leave_message)
        await RoomManager.leave_room(room_id, websocket)