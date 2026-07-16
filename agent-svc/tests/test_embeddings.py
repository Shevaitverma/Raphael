import os

from llm import embeddings


def test_embed_768_dims_and_no_network_at_inference():
    enc = embeddings.warm()  # loads the model (download happens once, at warm)
    v = enc.embed(["hello world"])
    assert len(v) == 1
    assert len(v[0]) == 768
    assert all(isinstance(x, float) for x in v[0])

    # After warm, inference must not touch the network. Force offline and embed.
    prev = {k: os.environ.get(k) for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")}
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        v2 = enc.embed(["a second, entirely different sentence"])
        assert len(v2) == 1 and len(v2[0]) == 768
    finally:
        for k, val in prev.items():
            if val is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = val


def test_prefix_reaches_the_model():
    enc = embeddings.get_encoder()
    # Default is the storage prefix; a query prefix must produce a different vector.
    doc = enc.embed(["the capital of France"])[0]
    qry = enc.embed(["the capital of France"], prefix="search_query: ")[0]
    assert doc != qry
    # Default really is search_document:, not "no prefix".
    assert enc.embed(["the capital of France"], prefix="search_document: ")[0] == doc


def test_embedding_model_name_recorded():
    enc = embeddings.get_encoder()
    assert enc.model_name == "nomic-embed-text-v1.5"
