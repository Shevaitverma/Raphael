package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

// cryptor holds an AES-256-GCM AEAD built from the base64 CREDENTIAL_ENC_KEY.
type cryptor struct {
	aead cipher.AEAD
}

// newCryptor decodes a base64 32-byte key and builds an AES-256-GCM AEAD.
// It fails loudly (returns an error) when the key is missing or the wrong size,
// so the service refuses to boot without a real key.
func newCryptor(b64Key string) (*cryptor, error) {
	if b64Key == "" {
		return nil, errors.New("CREDENTIAL_ENC_KEY is not set (generate one with: openssl rand -base64 32)")
	}
	key, err := base64.StdEncoding.DecodeString(b64Key)
	if err != nil {
		return nil, fmt.Errorf("CREDENTIAL_ENC_KEY is not valid base64: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("CREDENTIAL_ENC_KEY must decode to 32 bytes for AES-256, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &cryptor{aead: aead}, nil
}

// encrypt returns nonce||ciphertext. Each call uses a fresh random nonce.
func (c *cryptor) encrypt(plaintext string) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	// Seal appends ciphertext to nonce so the stored blob is self-contained.
	return c.aead.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

// decrypt reverses encrypt: it splits nonce||ciphertext and opens it.
func (c *cryptor) decrypt(blob []byte) (string, error) {
	ns := c.aead.NonceSize()
	if len(blob) < ns {
		return "", errors.New("ciphertext too short")
	}
	nonce, ct := blob[:ns], blob[ns:]
	pt, err := c.aead.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
