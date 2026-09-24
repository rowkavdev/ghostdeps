package forms

import (
	"database/sql"

	_ "github.com/lib/pq" // driver registered by side effect
)

/*
import "github.com/not/real" inside a block comment is not an import
*/

var notAnImport = `import "github.com/also/not/real"`

func Open() (*sql.DB, error) { return sql.Open("postgres", "") }
