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
from typing import Dict, Set, Optional
import asyncio
import uuid
import logging
import json

logger = logging.getLogger("oaktable.signaling")

router = APIRouter()


# Global mapping: peer_id -> WebSocket (for looking up peer connections)
_peer_registry: Dict[str, WebSocket] = {}

# WebSocket -> peer_id mapping
_ws_to_peer: Dict[int, str] = {}


class RoomManager:
    """Manages WebSocket connections for each signaling room."""

    # room_id -> set of active WebSocket connections
    _rooms: Dict[str, Set[WebSocket]] = {}

    # room_id -> set of peer_id strings
    _room_peers: Dict[str, Set[str]] = {}

    @classmethod
    async def join_room(
        cls, room_id: str, websocket: WebSocket, peer_id: str | None = None
    ) -> None:
        """Add a websocket to a room, creating the room if necessary."""
        await websocket.accept()
        if room_id not in cls._rooms:
            cls._rooms[room_id] = set()
            cls._room_peers[room_id] = set()
        cls._rooms[room_id].add(websocket)
        if peer_id:
            cls._room_peers[room_id].add(peer_id)
            _peer_registry[peer_id] = websocket
            _ws_to_peer[id(websocket)] = peer_id
        logger.info(
            f"[JOIN] peer_id={peer_id} room={room_id} ws={id(websocket)} "
            f"peers_in_room={cls._room_peers[room_id]}"
        )

    @classmethod
    async def leave_room(cls, room_id: str, websocket: WebSocket) -> None:
        """Remove a websocket from a room. Delete room if empty."""
        ws_id = id(websocket)
        # Unregister peer if mapped
        mapped_peer = _ws_to_peer.pop(ws_id, None)
        if mapped_peer:
            _peer_registry.pop(mapped_peer, None)
        if room_id in cls._rooms:
            cls._rooms[room_id].discard(websocket)
            if room_id in cls._room_peers:
                peer_set = cls._room_peers[room_id]
                peer_set.discard(mapped_peer) if mapped_peer else None
                logger.info(
                    f"[LEAVE] peer_id={mapped_peer} room={room_id} ws={ws_id} "
                    f"remaining_peers={peer_set}"
                )
                if not peer_set:
                    del cls._room_peers[room_id]
                    if room_id in cls._rooms:
                        del cls._rooms[room_id]
                    logger.info(f"[ROOM_DELETE] room={room_id} removed")
            else:
                logger.info(f"[LEAVE] peer_id={mapped_peer} room={room_id} ws={ws_id} remaining={len(cls._rooms[room_id])}")
                if not cls._rooms[room_id]:
                    del cls._rooms[room_id]
                    logger.info(f"[ROOM_DELETE] room={room_id} removed")

    @classmethod
    async def broadcast(
        cls, room_id: str, message: dict, exclude: WebSocket | None = None
    ) -> None:
        """Broadcast a message to all peers in a room, optionally excluding one."""
        if room_id not in cls._rooms:
            logger.warning(f"[BROADCAST] room={room_id} does not exist")
            return
        target_type = message.get("type", "unknown")
        exclude_id = id(exclude) if exclude else None
        exclude_peer = None
        if exclude and exclude_id in _ws_to_peer:
            exclude_peer = _ws_to_peer[exclude_id]
        
        # Determine target peers (who will receive this message)
        peers_in_room = cls._room_peers.get(room_id, set())
        target_peers = set(peers_in_room)
        if exclude_peer:
            target_peers.discard(exclude_peer)
        
        recipients = 0
        disconnected: Set[WebSocket] = set()
        for ws in cls._rooms[room_id]:
            ws_id = id(ws)
            if ws_id == exclude_id:
                logger.debug(f"[BROADCAST] room={room_id} type={target_type} skip sender ws={ws_id}")
                continue
            try:
                await ws.send_json(message)
                recipients += 1
            except (WebSocketDisconnect, RuntimeError) as e:
                logger.warning(f"[BROADCAST] room={room_id} type={target_type} failed to ws={ws_id}: {e}")
                disconnected.add(ws)
        
        logger.info(
            f"[BROADCAST] room={room_id} type={target_type} "
            f"from_peer={exclude_peer} to_peers={target_peers} recipients={recipients}"
        )
        # Clean up any dead connections found during broadcast
        for ws in disconnected:
            await cls.leave_room(room_id, ws)

    @classmethod
    def room_size(cls, room_id: str) -> int:
        """Return the number of peers currently in a room."""
        return len(cls._rooms.get(room_id, set()))

    @classmethod
    def get_peers_in_room(cls, room_id: str) -> Set[str]:
        """Return the set of peer_ids in a room."""
        return cls._room_peers.get(room_id, set()).copy()


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
    logger.info(f"[CONNECT] peer_id={peer_id} room_id={room_id} ws={id(websocket)}")
    await RoomManager.join_room(room_id, websocket, peer_id)

    # Announce new peer joined to existing peers in the room
    join_message = {
        "type": "peer-joined",
        "peer_id": peer_id,
        "room_size": RoomManager.room_size(room_id),
    }
    logger.info(
        f"[ANNOUNCE] peer_id={peer_id} joined room={room_id}, "
        f"notifying existing peers: {RoomManager._room_peers.get(room_id, set()) - {peer_id}}"
    )
    await RoomManager.broadcast(room_id, join_message, exclude=websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = __import__("json").loads(raw)
            except Exception:
                logger.warning(f"[MESSAGE] peer_id={peer_id} malformed JSON: {raw[:200]}")
                continue

            # Wrap in standard envelope if the client sent a bare payload
            if "type" not in message:
                message = {"type": "signal", "from": peer_id, "payload": message}
            else:
                message.setdefault("from", peer_id)

            msg_type = message.get("type", "unknown")
            msg_from = message.get("from", "?")
            logger.info(f"[MESSAGE] peer_id={peer_id} type={msg_type} from={msg_from} payload_keys={list(message.keys())}")

            # Relay to other peers in the room
            await RoomManager.broadcast(room_id, message, exclude=websocket)

    except WebSocketDisconnect:
        logger.info(f"[DISCONNECT] peer_id={peer_id} room_id={room_id} ws={id(websocket)}")
    finally:
        leave_message = {
            "type": "peer-left",
            "peer_id": peer_id,
            "room_size": RoomManager.room_size(room_id),
        }
        logger.info(
            f"[ANNOUNCE] peer_id={peer_id} leaving room={room_id}, "
            f"remaining peers: {RoomManager._room_peers.get(room_id, set())}"
        )
        await RoomManager.broadcast(room_id, leave_message)
        await RoomManager.leave_room(room_id, websocket)
