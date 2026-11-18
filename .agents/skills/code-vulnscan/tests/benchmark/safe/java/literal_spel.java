// BENCHMARK: safe - constant expression
import org.springframework.expression.ExpressionParser;
import org.springframework.expression.spel.standard.SpelExpressionParser;

public class SafeRuleEvaluator {
    private final ExpressionParser parser = new SpelExpressionParser();

    public Object evaluateHealth() {
        return parser.parseExpression("'healthy'").getValue();
    }
}
