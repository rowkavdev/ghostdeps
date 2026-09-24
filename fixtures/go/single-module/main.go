package main

import (
	"fmt"

	"github.com/google/uuid"
	yaml "gopkg.in/yaml.v3"
)

func main() {
	id := uuid.New()
	out, _ := yaml.Marshal(map[string]string{"id": id.String()})
	fmt.Print(string(out))
}
