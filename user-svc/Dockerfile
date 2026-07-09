# syntax=docker/dockerfile:1
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/user-svc ./...

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/user-svc /user-svc
EXPOSE 8081
USER nonroot:nonroot
ENTRYPOINT ["/user-svc"]
