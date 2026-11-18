// BENCHMARK: vulnerable - Spring Kotlin SQL injection
import jakarta.persistence.EntityManager
import org.springframework.web.bind.annotation.*

@RestController
class SearchController(private val entityManager: EntityManager) {
    @GetMapping("/search")
    fun search(@RequestParam name: String): Any {
        val sql = "SELECT * FROM users WHERE name = '$name'"
        return entityManager.createNativeQuery(sql).resultList
    }
}
