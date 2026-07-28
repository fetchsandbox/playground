"""Acme Notes — API (greenfield: Descope auth NOT wired yet).

A tiny notes backend with a PLACEHOLDER login that trusts whatever the client
sends — there is no real authentication yet. Your task (via the fetchsandbox
MCP): add real Descope OTP sign-up + a validated session — but PROVE the Descope
flow in FetchSandbox FIRST, then propose the diff. Don't write auth code blind.

Surface:
  POST /signup     placeholder: trusts the email, returns a fake token
  GET  /notes      list notes for the (insecurely) identified user
  POST /notes      add a note
"""
from __future__ import annotations

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Acme Notes")

# In-memory store keyed by user. Fine for a stub.
_NOTES: dict[str, list[str]] = {}


class SignupReq(BaseModel):
    email: str


class Note(BaseModel):
    text: str


@app.post("/signup")
def signup(body: SignupReq) -> dict:
    # TODO(descope): replace with Descope OTP — send a code, verify it, and
    # return a real session (sessionJwt / refreshJwt). Right now we just trust
    # the email and hand back a fake token.
    _NOTES.setdefault(body.email, [])
    return {"ok": True, "user": body.email, "session": "INSECURE-PLACEHOLDER-TOKEN"}


def _current_user(authorization: str) -> str:
    # TODO(descope): validate the Descope session JWT (validateSession + JWKS,
    # algorithm pinned, expiry checked). Right now the "session" IS trusted
    # verbatim as the user id — anyone can forge it.
    token = authorization.replace("Bearer ", "", 1)
    if not token:
        raise HTTPException(401, "no session")
    return token


@app.get("/notes")
def list_notes(authorization: str = Header(default="")) -> dict:
    user = _current_user(authorization)
    return {"notes": _NOTES.get(user, [])}


@app.post("/notes")
def add_note(note: Note, authorization: str = Header(default="")) -> dict:
    user = _current_user(authorization)
    _NOTES.setdefault(user, []).append(note.text)
    return {"ok": True, "count": len(_NOTES[user])}
